import { Module, MedusaService } from "@medusajs/framework/utils"
import crypto from "crypto"
import { ErpnextSyncEvent } from "./models/sync-event"
import { ErpnextSetting } from "./models/setting"
import { ErpnextMapping } from "./models/mapping"
import { ErpnextLink } from "./models/link"
import {
    applyMapping,
    getByPath,
    isTemplatePath,
    unmetRequired,
    type MappingDirection,
    type MappingFieldPair,
    type TransformOptions,
} from "./mapping-engine"
import { getMedusaEntity, handleFromKey } from "./registry"
import { discoverEntityFields } from "./discovery-runtime"
import { ErpnextInvoice } from "./models/invoice"
import { formatInvoiceNumber, receivesErpInvoices, storeNumbers } from "./invoice-number"
import { invoiceKey, storageFor } from "./invoice-storage"
import * as breakerRules from "./breaker"
import { mayEnable, signatureOf } from "./signature"
import {
    buildAutofill,
    type AutofillResult,
    type CanonicalPairLookup,
    type DoctypeFieldMeta,
} from "./autofill"
import {
    evaluatePush,
    parseAllowlist,
    type PushDecision,
} from "./push-guard"
import { evaluateTrigger, presetCondition, validateTrigger } from "./trigger"
import { mergeDirection, mergeEvents, mergeFieldPairs, pairUidOf } from "./pair-identity"
import { entityRefOf } from "./echo"
import { OUTBOUND_PAUSED, OUTBOUND_PAUSED_MESSAGE, pausedResult } from "./outbound"
import {
    DEFAULT_SYNC_DOCTYPES,
    PULL_VALUES,
    SELECTION_FIELD,
    isSyncDoctype,
    normalizeSyncDoctypes,
    pushAllowedByRecord,
    resolveProductsDoctype,
    withSelectionFilter,
    type SyncDoctype,
} from "./selection"
import { FrappeWebhookBody, frappeEventId, planFrappeEvent } from "./frappe-webhook"
import { makeFrappeClient } from "./frappe-client"
import { runErpnextSetup, type SetupReport } from "./erpnext-setup"
import {
    DEFAULT_PRODUCT_POLICY,
    decideProductPush,
    isLinked,
    normalizeProductPolicy,
    LINK_KEY,
} from "./product-policy"

/** Write a dotted path into a plain object, creating what it passes through. */
function setByPath(target: Record<string, any>, dotted: string, value: any): void {
    const parts = String(dotted || "").split(".").filter(Boolean)
    if (!parts.length) return
    let cursor = target
    for (const key of parts.slice(0, -1)) {
        if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {}
        cursor = cursor[key]
    }
    cursor[parts[parts.length - 1]] = value
}

/**
 * A plausible value for one declared path.
 *
 * Plausible matters more than pretty: a mapping that parses a date or
 * multiplies a number should meet a date and a number here, not the
 * string "sample", or the rehearsal passes and the real push does not.
 */
function placeholderFor(p: { path: string; type?: string; label?: string }): any {
    switch (p.type) {
        case "number":
            return 1
        case "boolean":
            return false
        case "datetime":
            return new Date().toISOString()
        case "array":
            return []
        case "id":
            return `sample_${String(p.path).replace(/[^a-z0-9]+/gi, "_")}`
        default:
            return `Sample ${p.label ?? p.path}`
    }
}

export const ERPNEXT_MODULE = "erpnext"

// Doctypes whose ERPNext record is a header + a child line-items table.
// A flat field mapping can populate the header, but not the child rows,
// so pushes for these get the extra `medusa_items` / customer fields
// attached from the enriched Medusa order record. See augmentSalesDocPayload.
const SALES_DOCTYPES = new Set(["Sales Order", "Sales Invoice"])

/**
 * Enrich a mapped Customer payload with GSTIN + the address list a flat field
 * mapping cannot express (ERPNext Address is a separate doctype linked to the
 * Customer). `record` is the enriched customer from the registry customerEntity
 * fetchById (addresses[] + resolved gstin/company). Emits:
 *   - `gstin` — rides through `_set_fields` onto ERPNext `Customer.gstin`.
 *   - `medusa_addresses[]` — normalized + stable-id'd; the Frappe `address_sync`
 *     handler turns each into a linked Address doc (idempotent by id). The
 *     company's GST-registered billing address is added as a synthetic entry.
 * No-op for any other doctype (keeps the plugin generic).
 */
function augmentCustomerPayload(
    doctype: string,
    payload: Record<string, any>,
    record: any,
): Record<string, any> {
    if (doctype !== "Customer" || !record) return payload
    const out: Record<string, any> = { ...payload }
    if (out.gstin == null && record.gstin) out.gstin = record.gstin

    const addresses: any[] = Array.isArray(record.addresses) ? record.addresses : []
    const mapped: any[] = addresses
        .filter((a) => a && a.id)
        .map((a) => ({
            medusa_address_id: a.id,
            address_title:
                a.company ||
                [a.first_name, a.last_name].filter(Boolean).join(" ") ||
                record.company_trade_name ||
                null,
            address_type: a.is_default_billing
                ? "Billing"
                : a.is_default_shipping
                  ? "Shipping"
                  : "Billing",
            address_line1: a.address_1 ?? null,
            address_line2: a.address_2 ?? null,
            city: a.city ?? null,
            state: a.province ?? null,
            pincode: a.postal_code ?? null,
            country_code: a.country_code ?? null,
            phone: a.phone ?? null,
        }))

    // The company's GST-registered billing address is the invoice address in
    // this B2B model — emit it as a synthetic entry keyed on the company id so
    // it dedupes like any other address on re-push.
    const cba = record.company_billing_address
    if (cba && (cba.line1 || cba.address_1)) {
        mapped.push({
            medusa_address_id: `company:${record.company_id_resolved ?? "billing"}`,
            address_title: record.company_trade_name || "Company Billing",
            address_type: "Billing",
            address_line1: cba.line1 ?? cba.address_1 ?? null,
            address_line2: cba.line2 ?? cba.address_2 ?? null,
            city: cba.city ?? null,
            state: cba.state ?? cba.province ?? null,
            pincode: cba.postal_code ?? null,
            country_code: cba.country_code ?? null,
            phone: cba.phone ?? null,
        })
    }

    if (mapped.length) out.medusa_addresses = mapped
    return out
}

/**
 * Enrich a mapped payload for Sales Order / Sales Invoice pushes with the
 * child line items and customer link a flat mapping cannot express. No-op
 * for any other doctype (keeps the plugin generic). Monetary values are
 * converted from Medusa minor units (paise) to rupees.
 */
function augmentSalesDocPayload(
    doctype: string,
    payload: Record<string, any>,
    record: any,
): Record<string, any> {
    if (!SALES_DOCTYPES.has(doctype) || !record) return payload
    const out: Record<string, any> = { ...payload }
    if (out.medusa_customer_id == null) {
        out.medusa_customer_id = record.customer_id ?? record.customer?.id ?? null
    }
    if (out.contact_email == null) {
        out.contact_email = record.email ?? null
    }
    const items = Array.isArray(record.items) ? record.items : []
    out.medusa_items = items.map((li: any) => ({
        item_code:
            li?.variant?.product?.handle ??
            li?.variant?.sku ??
            li?.title,
        item_name: li?.title ?? li?.variant?.product?.title ?? li?.variant?.title,
        qty: li?.quantity ?? 1,
        // Medusa stores money in minor units (paise); ERPNext wants rupees.
        rate: (Number(li?.unit_price) || 0) / 100,
    }))
    // ── Fix 3: order financials + addresses + payment reference ──────────
    const toRupees = (v: any) => (Number(v) || 0) / 100
    const addr = (a: any) =>
        a
            ? {
                  name: [a.first_name, a.last_name].filter(Boolean).join(" ") || null,
                  address_line1: a.address_1 ?? null,
                  address_line2: a.address_2 ?? null,
                  city: a.city ?? null,
                  state: a.province ?? null,
                  pincode: a.postal_code ?? null,
                  country: a.country_code ?? null,
                  phone: a.phone ?? null,
              }
            : null
    out.medusa_shipping_address = addr(record.shipping_address)
    out.medusa_billing_address = addr(record.billing_address)
    // Derive financials from the line items + the stored grand total. The SO
    // line rates == item unit_prices (net_total == subtotal), tax == sum of
    // line tax, and the residual (grand − subtotal − tax) buckets to shipping
    // (if positive) or discount (if negative) — so the ERPNext grand_total
    // always reconciles to the Medusa order total exactly, even though the
    // order module won't hand us a clean shipping/discount breakdown.
    const subtotalP = items.reduce(
        (s: number, li: any) => s + (Number(li?.unit_price) || 0) * (Number(li?.quantity) || 1),
        0,
    )
    const taxP = items.reduce((s: number, li: any) => s + (Number(li?.tax_total) || 0), 0)
    const grandP = Number(record.total) || 0
    const residualP = grandP - subtotalP - taxP
    out.medusa_tax_total = toRupees(taxP)
    out.medusa_shipping_total = toRupees(Math.max(0, residualP))
    out.medusa_discount_total = toRupees(Math.max(0, -residualP))
    out.medusa_grand_total = toRupees(grandP)
    // Payment reference: keep the fetch cheap (loading nested
    // payment_collections.payments crashes the order-module query), so derive
    // from the collection + order-level payment status.
    const pc = Array.isArray(record.payment_collections)
        ? record.payment_collections[0]
        : null
    out.medusa_payment_method = record.payment_status ?? null
    out.medusa_payment_reference = pc?.id ?? null
    return out
}

const DEFAULT_TIMEOUT_MS = 15_000
const ERROR_TRUNCATE = 1000
const SINGLETON_KEY = "default"

type ForwardArgs = {
    /** Medusa event name, e.g. "customer.created". */
    event: string
    /** Medusa event.id — used to dedupe on the Frappe side. */
    event_id: string
    /** Already-enriched payload (the subscriber fetches the full
     *  customer/order before calling us). */
    data: any
    /**
     * The retry job's one delivery per run to a connection the breaker has
     * given up on. Somebody has to knock, or it never learns ERPNext came
     * back. See ../breaker.ts.
     */
    probe?: boolean
}

type ForwardResult =
    | { ok: true; status: "success" | "skipped"; reason?: string; action?: string }
    | { ok: false; status: "failed"; httpStatus?: number; error: string }

type SaveSettingsInput = {
    enable_sync?: boolean
    /** Orders and invoices — what this store wants ERPNext to do with an
     *  order. Honoured by the Phase 2 push; see models/setting.ts. */
    order_document?: string | null
    invoice_numbering?: "erpnext" | "store" | null
    store_invoice_prefix?: string | null
    send_invoice_to_store?: boolean
    record_payments?: boolean
    /** This store's own choice of where invoice PDFs are kept. */
    invoice_storage?: "local" | "s3" | null
    invoice_local_dir?: string | null
    s3_bucket?: string | null
    s3_region?: string | null
    s3_endpoint?: string | null
    s3_prefix?: string | null
    s3_force_path_style?: boolean
    /** Secrets: empty string = unchanged, null = clear. */
    s3_access_key_id?: string | null
    s3_secret_access_key?: string | null
    /** "off" | "link" | "create" — see ./product-policy.ts. */
    medusa_product_policy?: string | null
    /** Empty string = unchanged, null = clear, value = update. Same
     *  contract Medusa's own settings pages use. */
    erpnext_url?: string | null
    /** Where ERPNext reaches this store: the Webhooks POST to
     *  `<medusa_public_url>/webhooks/erpnext-inbound`. Falls back to
     *  MEDUSA_BACKEND_URL. */
    medusa_public_url?: string | null
    /** The DocTypes that carry the `medusa_sync` field, each with its
     *  allow/deny mode. See ./selection.ts. */
    sync_doctypes?: Array<{ doctype: string; mode?: string }> | null
    /** The secret every Frappe Webhook signs with. Generated by Set up
     *  ERPNext when empty; secret semantics like the others. */
    frappe_webhook_secret?: string | null
    /** ISO 3166 region the `phone` transform assumes for a number with no
     *  country code. */
    phone_region?: string | null
    erpnext_api_key?: string | null
    erpnext_api_secret?: string | null
    request_timeout_ms?: number
    auto_retry_failed?: boolean
    auto_retry_max_attempts?: number
    auto_retry_min_interval_minutes?: number
    last_full_resync_at?: string | null
    /** Outbound safety valve. Newline/comma separated identifiers;
     *  empty or null = no restriction. NOT a secret, so it follows
     *  the plain `"key" in input` contract rather than the
     *  empty-string-means-unchanged one the secrets use. */
    push_allowlist?: string | null
    log_retention_days?: number
    notes?: string | null
    updated_by_user_id?: string | null
}

type ActiveConfig = {
    enable_sync: boolean
    /** What may happen when a product is created here. */
    medusa_product_policy: string
    /** The DocTypes under `medusa_sync` selection, with their modes. */
    sync_doctypes: SyncDoctype[]
    erpnext_url: string | null
    /** What every Frappe Webhook row signs with. */
    frappe_webhook_secret: string | null
    /** Where ERPNext POSTs webhooks; absolute http(s) or null. */
    medusa_public_url: string | null
    /** What the last Set up ERPNext did, or null before the first. */
    erpnext_setup_report: SetupReport | null
    request_timeout_ms: number
    auto_retry_failed: boolean
    auto_retry_max_attempts: number
    auto_retry_min_interval_minutes: number
    /** Whether config came from DB row vs. env-var fallback. Useful
     *  for the admin "configured: ✓/✗" badge. */
    source: { url: "row" | "env" | "missing"; secret: "row" | "env" | "missing" }
}

/**
 * ErpnextModuleService — owns:
 *   1. The `erpnext_sync_event` log table (every sync attempt, both ways).
 *   2. The `erpnext_setting` singleton (URL / secrets / toggles).
 *   3. The `erpnext_mapping` rules and the `erpnext_link` map.
 *
 * ERPNext → Medusa arrives through Frappe core Webhooks
 * (api/webhooks/erpnext-inbound) and the pull job; both go through the
 * mapping engine and the entity registry. Medusa → ERPNext is paused
 * (./outbound.ts) until Phase 2 writes over REST.
 *
 * Failure handling: HTTP failures are caught and logged on the row;
 * the caller never sees a thrown error, so order placement on the
 * storefront is never blocked by an ERPNext outage.
 */
class ErpnextModuleService extends MedusaService({
    ErpnextSyncEvent,
    ErpnextSetting,
    ErpnextMapping,
    ErpnextLink,
    ErpnextInvoice,
}) {


    /**
     * The legacy full-payload push. Paused — see ./outbound.ts. A row is
     * still written so the event shows in the log and can be replayed once
     * a transport exists again.
     */
    async forwardEvent(args: ForwardArgs): Promise<ForwardResult> {
        const cfg = await this.getActiveConfig()
        if (!cfg.enable_sync) {
            return { ok: true, status: "skipped", reason: "sync-disabled" }
        }
        await this.upsertEventRow(args, {
            status: "skipped",
            last_error: OUTBOUND_PAUSED_MESSAGE,
            target_url: null,
            action: "paused",
        })
        return pausedResult()
    }

    /** Where the connection stands, for the admin and for the retry job. */
    async breakerState(): Promise<any> {
        const row: any = await this.findSettingsRow()
        return breakerRules.stateOf(row)
    }

    /** Forget the failures and start trying again. What the button does. */
    async closeBreaker(): Promise<any> {
        const row: any = await this.findSettingsRow()
        if (row?.id) {
            await this.updateErpnextSettings({
                id: row.id,
                consecutive_failures: 0,
                tripped_at: null,
            } as any)
        }
        return this.breakerState()
    }

    /**
     * Which enabled mappings name an ERPNext field that no longer exists?
     *
     * ERPNext moves. A customisation is removed, an app is uninstalled, a
     * field is renamed, and a mapping that worked for a year starts
     * referring to nothing. It fails silently — the payload simply stops
     * carrying that field — and somebody notices a month later from the
     * wrong end.
     *
     * The one it finds is switched off, because it cannot do what it says.
     * Only that one: a check that stopped every mapping because one went
     * stale would be worse than the drift.
     *
     * Never throws. It runs from a scheduled job, and a job that dies on
     * one bad mapping stops checking the rest.
     */
    async checkMappingDrift(): Promise<any> {
        const report: any = { checked: 0, flagged: [], cleared: [], errors: [] }
        let mappings: any[] = []
        try {
            mappings = await this.listErpnextMappings({ enabled: true } as any, { take: 500 })
        } catch (err: any) {
            report.errors.push(describeError(err))
            return report
        }

        // One fetch per doctype, not per mapping: the meta call crosses the
        // network and several mappings usually share a doctype.
        const fieldsByDoctype = new Map<string, Set<string> | null>()
        const alwaysValid = new Set([
            "name",
            "owner",
            "creation",
            "modified",
            "docstatus",
            "idx",
            // Link keys. The shipped push presets still name these
            // (`id → medusa_customer_id` and so on) and they are not columns
            // on a vanilla ERPNext; the push is paused, and the Phase 2
            // transport decides what becomes of them. Without this every
            // preset mapping would be switched off the first time this
            // check runs, for fields nobody removed by mistake.
            "medusa_customer_id",
            "medusa_product_id",
            "medusa_variant_id",
            "medusa_order_id",
            "medusa_address_id",
            "medusa_payment_id",
            "medusa_invoice_id",
            "medusa_display_id",
            "medusa_order_source",
            "medusa_payment_method",
            "medusa_payment_reference",
            "medusa_customer_tier",
        ])

        for (const mapping of mappings) {
            report.checked += 1
            try {
                const doctype = String(mapping.doctype ?? "").trim()
                const pairs = Array.isArray(mapping.field_mappings) ? mapping.field_mappings : []
                if (!doctype || !pairs.length) continue

                if (!fieldsByDoctype.has(doctype)) {
                    let known: Set<string> | null = null
                    try {
                        const meta: any = await this.getDoctypeMeta(doctype)
                        if (meta?.ok && Array.isArray(meta.fields)) {
                            known = new Set(
                                meta.fields
                                    .map((f: any) => String(f?.fieldname ?? ""))
                                    .filter(Boolean),
                            )
                        }
                    } catch {
                        // ERPNext unreachable. Not knowing is not the same
                        // as knowing it is gone, so say nothing this run.
                        known = null
                    }
                    fieldsByDoctype.set(doctype, known)
                }

                const known = fieldsByDoctype.get(doctype)
                if (!known) continue

                const missing = pairs
                    .map((p: any) => String(p?.erpnext_field ?? p?.frappe_field ?? ""))
                    .filter((f: string) => f && !known.has(f) && !alwaysValid.has(f))

                if (!missing.length) {
                    if (mapping.attention === "Field Missing") {
                        await this.updateErpnextMappings({
                            id: mapping.id,
                            attention: null,
                            attention_detail: null,
                        } as any)
                        report.cleared.push(mapping.name ?? mapping.id)
                    }
                    continue
                }

                const detail =
                    `${doctype} no longer has: ${missing.join(", ")}. This mapping is switched ` +
                    `off until it does, or until the field map stops asking for it.`
                await this.updateErpnextMappings({
                    id: mapping.id,
                    enabled: false,
                    attention: "Field Missing",
                    attention_detail: detail,
                    version: Number(mapping.version ?? 1) + 1,
                } as any)
                report.flagged.push({ name: mapping.name ?? mapping.id, missing })
            } catch (err: any) {
                report.errors.push({ mapping: mapping?.name ?? mapping?.id, error: describeError(err) })
            }
        }
        return report
    }

    /** Every mapping waiting on somebody. What a dashboard would show. */
    async mappingsNeedingAttention(): Promise<any[]> {
        try {
            const rows = await this.listErpnextMappings(
                { attention: { $ne: null } } as any,
                { take: 200 },
            )
            return rows as any[]
        } catch {
            return []
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Invoices customers can download
    // ─────────────────────────────────────────────────────────────────

    /**
     * The store's own number for an order's invoice, when this store
     * numbers invoices itself. Idempotent per order: a retried push must
     * carry the number the first attempt took, not burn another.
     *
     * The running number is taken in one UPDATE … RETURNING, so two
     * orders placed in the same instant can never share a number.
     *
     * The read below cannot settle it alone: a subscriber and the retry
     * job can both find no row and both go on to allocate, and since each
     * takes a distinct number the unique index on `number` would not
     * notice. UQ_erpnext_invoice_store_order — one store invoice per
     * order — is what actually decides the winner, and the loser adopts
     * the number that won rather than issuing a second invoice. That
     * leaves the loser's number unused, a gap in the series being the
     * cheaper fault of the two.
     */
    async allocateStoreInvoiceNumber(scope: any, orderId: string, customerId?: string | null): Promise<string | null> {
        const row = await this.findSettingsRow()
        if (!storeNumbers(row)) return null
        const [existing] = await this.listErpnextInvoices({ order_id: orderId, source: "store" }, { take: 1 })
        if (existing) return existing.number
        if (!row?.store_invoice_prefix) {
            throw new Error("this store numbers its invoices but has no invoice prefix; set one under Orders and invoices")
        }
        const pg: any = scope.resolve("__pg_connection__")
        const result = await pg.raw(
            `UPDATE "erpnext_setting" SET store_invoice_next = store_invoice_next + 1
              WHERE singleton_key = ? RETURNING store_invoice_next - 1 AS n`,
            [SINGLETON_KEY],
        )
        const n = Number(result?.rows?.[0]?.n)
        const number = formatInvoiceNumber(row.store_invoice_prefix, n)
        try {
            await this.createErpnextInvoices([
                { order_id: orderId, customer_id: customerId ?? null, number, source: "store", status: "issued" },
            ])
        } catch (e: any) {
            if (!isUniqueViolation(e)) throw e
            const [won] = await this.listErpnextInvoices({ order_id: orderId, source: "store" }, { take: 1 })
            if (!won) throw e
            return won.number
        }
        return number
    }

    /**
     * ERPNext issued an invoice for an order. Record it, and when this
     * store takes ERPNext's invoices, fetch the PDF into private storage.
     * A failed fetch is recorded on the row rather than failing the event:
     * the invoice facts are already correct, and the PDF can be fetched
     * again from the admin.
     */
    async receiveErpInvoice(scope: any, data: any): Promise<any> {
        const orderId = String(data?.medusa_order_id ?? "").trim()
        const number = String(data?.invoice_number ?? "").trim()
        if (!orderId || !number) return { skipped: "missing order or invoice number" }
        const settings = await this.findSettingsRow()
        const orderSvc: any = scope.resolve("order")
        const [order] = await orderSvc.listOrders({ id: orderId }, { take: 1, select: ["id", "customer_id"] })
        const facts = {
            order_id: orderId,
            customer_id: order?.customer_id ?? null,
            number,
            source: "erpnext",
            invoice_date: data?.invoice_date ?? null,
            total: data?.grand_total != null ? Number(data.grand_total) : null,
            currency: data?.currency ?? null,
            status: data?.status ?? null,
        }
        const [existing] = await this.listErpnextInvoices({ number }, { take: 1 })
        const invoice = existing
            ? (await this.updateErpnextInvoices([{ id: existing.id, ...facts }]))[0]
            : (await this.createErpnextInvoices([facts]))[0]

        if (!data?.pdf || !receivesErpInvoices(settings)) return { id: invoice.id, pdf: "not requested" }
        return { id: invoice.id, pdf: await this.fetchInvoicePdf(invoice.id, data.pdf) }
    }

    /** Pull one invoice PDF from ERPNext and keep it privately. */
    async fetchInvoicePdf(invoiceId: string, pdf?: { doctype?: string; name?: string; print_format?: string | null }) {
        const [invoice] = await this.listErpnextInvoices({ id: invoiceId }, { take: 1 })
        if (!invoice) return { ok: false, error: "no such invoice" }
        const cfg = await this.getActiveConfig()
        const creds = await this.getApiCredentials()
        const settings = await this.findSettingsRow()
        try {
            if (!cfg.erpnext_url || !creds.api_key || !creds.api_secret) {
                throw new Error("ERPNext URL or API credentials are not configured")
            }
            const params = new URLSearchParams({
                doctype: pdf?.doctype || "Sales Invoice",
                name: pdf?.name || invoice.number,
            })
            if (pdf?.print_format) params.set("format", pdf.print_format)
            const res = await fetch(
                `${cfg.erpnext_url}/api/method/frappe.utils.print_format.download_pdf?${params}`,
                {
                    headers: { Authorization: `token ${creds.api_key}:${creds.api_secret}` },
                    signal: AbortSignal.timeout(Math.max(cfg.request_timeout_ms, 30_000)),
                },
            )
            if (!res.ok) throw new Error(`ERPNext answered HTTP ${res.status} for the invoice PDF`)
            const bytes = Buffer.from(await res.arrayBuffer())
            if (bytes.subarray(0, 4).toString() !== "%PDF") throw new Error("ERPNext did not return a PDF")
            const storage = storageFor(settings ?? {})
            const key = invoiceKey(invoice.order_id, invoice.number)
            await storage.put(key, bytes, "application/pdf")
            await this.updateErpnextInvoices([
                {
                    id: invoice.id,
                    storage: storage.kind,
                    object_key: key,
                    content_type: "application/pdf",
                    size_bytes: bytes.length,
                    fetched_at: new Date(),
                    fetch_error: null,
                },
            ])
            return { ok: true, size_bytes: bytes.length, storage: storage.kind }
        } catch (e: any) {
            const error = String(e?.message ?? e).slice(0, ERROR_TRUNCATE)
            await this.updateErpnextInvoices([{ id: invoice.id, fetch_error: error }])
            return { ok: false, error }
        }
    }

    /** Invoices for one order, newest first, without storage internals. */
    async invoicesForOrder(orderId: string) {
        const rows = await this.listErpnextInvoices({ order_id: orderId }, { order: { created_at: "DESC" } })
        return rows.map((r: any) => ({
            id: r.id,
            number: r.number,
            source: r.source,
            invoice_date: r.invoice_date,
            total: r.total,
            currency: r.currency,
            status: r.status,
            downloadable: Boolean(r.object_key),
        }))
    }

    /** The stored PDF for one invoice, or null. Callers check ownership. */
    async openInvoice(invoiceId: string) {
        const [invoice] = await this.listErpnextInvoices({ id: invoiceId }, { take: 1 })
        if (!invoice?.object_key) return null
        const settings = await this.findSettingsRow()
        const object = await storageFor({ ...(settings ?? {}), invoice_storage: invoice.storage }).get(invoice.object_key)
        return object ? { invoice, object } : null
    }









    private async upsertInboundEventRow(
        args: { event: string; event_id: string; data: any },
        patch: {
            status: string
            last_error: string | null
            entity_ref?: string | null
            /** A rehearsal, not real traffic. See the model. */
            is_test?: boolean
            action?: string | null
        },
    ) {
        const [existing] = await this.listErpnextSyncEvents(
            { event_id: args.event_id, direction: "inbound" as any },
            { take: 1 },
        )
        const now = new Date()
        if (existing) {
            const [updated] = await this.updateErpnextSyncEvents([
                {
                    id: existing.id,
                    attempts: (existing.attempts ?? 0) + 1,
                    last_attempt_at: now,
                    payload: args.data,
                    event: args.event,
                    ...patch,
                },
            ])
            return updated
        }
        const [created] = await this.createErpnextSyncEvents([
            {
                event: args.event,
                event_id: args.event_id,
                payload: args.data,
                attempts: 1,
                last_attempt_at: now,
                target_url: null,
                direction: "inbound",
                ...patch,
            },
        ])
        return created
    }


    /**
     * Re-attempt a previously failed (or skipped) event from its stored
     * payload. An inbound row is re-applied through the same executor the
     * webhook route uses; an outbound row waits for Phase 2.
     */
    async retryEvent(
        eventId: string,
        scope?: any,
        opts?: { probe?: boolean },
    ): Promise<ForwardResult> {
        const [row] = await this.listErpnextSyncEvents(
            { event_id: eventId },
            { take: 1 },
        )
        if (!row) {
            return {
                ok: false,
                status: "failed",
                error: `no row for event_id=${eventId}`,
            }
        }
        if (row.direction === "inbound") {
            if (!scope) {
                return {
                    ok: false,
                    status: "failed",
                    error: "inbound event retry needs a request scope",
                }
            }
            const replayed = await this.replayInboundEvent(row, scope)
            return replayed.ok
                ? { ok: true, status: "success" }
                : { ok: false, status: "failed", error: replayed.error ?? "replay failed" }
        }
        if (OUTBOUND_PAUSED) return pausedResult()
        if (row.mapping_id) {
            const [mapping] = await this.listErpnextMappings(
                { id: row.mapping_id },
                { take: 1 },
            )
            if (mapping) {
                return this.pushViaMapping({
                    mapping,
                    event: row.event,
                    event_id: row.event_id,
                    record: row.payload,
                    container: scope,
                })
            }
        }
        return this.forwardEvent({
            event: row.event,
            event_id: row.event_id,
            data: row.payload,
            probe: opts?.probe === true,
        })
    }

    /**
     * List the most recent failed/skipped events, oldest-attempt first
     * — the order a retry job would process them in.
     */
    async listFailedForRetry(limit = 50) {
        return this.listErpnextSyncEvents(
            // A rehearsal that failed is information, not a delivery owed
            // to anyone. Retrying one would send a fabricated payload for
            // real, which is the opposite of what a dry run is for.
            { status: ["failed", "skipped"] as any, is_test: false } as any,
            { take: limit, order: { last_attempt_at: "ASC" } },
        )
    }

    private async upsertEventRow(
        args: ForwardArgs,
        patch: {
            status: string
            last_error: string | null
            target_url: string | null
            mapping_id?: string | null
            /** What the sync did on the far side — created / updated /
             *  skipped. Distinct from `status`, which only says whether
             *  the call itself succeeded. */
            action?: string | null
            /** SHA-256 of the transformed payload, for skip-unchanged. */
            payload_hash?: string | null
            entity_ref?: string | null
        },
    ) {
        const [existing] = await this.listErpnextSyncEvents(
            { event_id: args.event_id },
            { take: 1 },
        )
        const now = new Date()
        if (existing) {
            const [updated] = await this.updateErpnextSyncEvents([
                {
                    id: existing.id,
                    attempts: (existing.attempts ?? 0) + 1,
                    last_attempt_at: now,
                    payload: args.data,
                    event: args.event,
                    ...patch,
                },
            ])
            return updated
        }
        const [created] = await this.createErpnextSyncEvents([
            {
                event: args.event,
                event_id: args.event_id,
                payload: args.data,
                attempts: 1,
                last_attempt_at: now,
                ...patch,
            },
        ])
        return created
    }


    /**
     * The row's current values with secrets masked, or defaults when no
     * row exists yet. Never the raw secrets — `getActiveConfig` and
     * `getFrappeWebhookSecret` are for those.
     */
    async getSettingsView() {
        const row = await this.findSettingsRow()
        const envFallback = {
            erpnext_url: process.env.ERPNEXT_URL ?? null,
            frappe_webhook_secret_present: Boolean(process.env.ERPNEXT_FRAPPE_WEBHOOK_SECRET),
            medusa_public_url: process.env.MEDUSA_BACKEND_URL ?? null,
        }
        if (!row) {
            return {
                exists: false,
                enable_sync: true,
                erpnext_url: null,
                medusa_public_url: null,
                frappe_webhook_secret_masked: maskSecret(process.env.ERPNEXT_FRAPPE_WEBHOOK_SECRET),
                erpnext_api_key_masked: null,
                erpnext_api_secret_masked: null,
                sync_doctypes: DEFAULT_SYNC_DOCTYPES,
                erpnext_setup_at: null,
                erpnext_setup_report: null,
                phone_region: DEFAULT_PHONE_REGION,
                medusa_product_policy: DEFAULT_PRODUCT_POLICY,
                request_timeout_ms: DEFAULT_TIMEOUT_MS,
                auto_retry_failed: true,
                auto_retry_max_attempts: 5,
                auto_retry_min_interval_minutes: 15,
                last_full_resync_at: null,
                push_allowlist: null,
                log_retention_days: 180,
                ...invoiceSettingsView(null),
                notes: null,
                updated_by_user_id: null,
                outbound_paused: OUTBOUND_PAUSED,
                env_fallback: envFallback,
            }
        }
        return {
            exists: true,
            enable_sync: row.enable_sync,
            medusa_product_policy: normalizeProductPolicy(row.medusa_product_policy),
            erpnext_url: row.erpnext_url,
            medusa_public_url: row.medusa_public_url ?? null,
            frappe_webhook_secret_masked: maskSecret(row.frappe_webhook_secret),
            erpnext_api_key_masked: maskSecret(row.erpnext_api_key),
            erpnext_api_secret_masked: maskSecret(row.erpnext_api_secret),
            sync_doctypes: syncDoctypesOf(row),
            erpnext_setup_at: row.erpnext_setup_at ?? null,
            erpnext_setup_report: row.erpnext_setup_report ?? null,
            phone_region: phoneRegionOf(row),
            request_timeout_ms: row.request_timeout_ms,
            auto_retry_failed: row.auto_retry_failed,
            auto_retry_max_attempts: row.auto_retry_max_attempts,
            auto_retry_min_interval_minutes: row.auto_retry_min_interval_minutes,
            last_full_resync_at: row.last_full_resync_at,
            // Not a secret — the operator must be able to read and edit
            // the list, so it is returned in full rather than masked.
            push_allowlist: row.push_allowlist ?? null,
            log_retention_days: row.log_retention_days ?? 180,
            ...invoiceSettingsView(row),
            notes: row.notes,
            updated_by_user_id: row.updated_by_user_id,
            outbound_paused: OUTBOUND_PAUSED,
            env_fallback: envFallback,
        }
    }


    /**
     * Persist the settings row.
     *
     * Secret-field semantics:
     *   - `undefined` (key absent)  → leave as-is
     *   - `""` (empty string)       → leave as-is (admin UI sends ""
     *                                  when the user didn't touch the
     *                                  field, since it shows the
     *                                  masked preview as a placeholder)
     *   - `null`                    → clear the field
     *   - any other string          → update
     */
    async saveSettings(input: SaveSettingsInput) {
        const existing = await this.findSettingsRow()
        const patch: Record<string, any> = {}

        if (input.enable_sync !== undefined) patch.enable_sync = input.enable_sync
        if ("medusa_product_policy" in input) {
            patch.medusa_product_policy = normalizeProductPolicy(input.medusa_product_policy)
        }
        if ("erpnext_url" in input) {
            patch.erpnext_url = normaliseUrl(input.erpnext_url)
        }
        if ("medusa_public_url" in input) {
            const raw = publicUrlOf(input.medusa_public_url)
            if (input.medusa_public_url && !raw) {
                throw new Error("medusa_public_url must be an absolute http(s) URL")
            }
            patch.medusa_public_url = raw
        }
        if ("sync_doctypes" in input) {
            patch.sync_doctypes = normalizeSyncDoctypes(input.sync_doctypes)
        }
        applySecret(patch, "frappe_webhook_secret", input.frappe_webhook_secret)
        if ("phone_region" in input) {
            patch.phone_region = phoneRegionOf({ phone_region: input.phone_region })
        }
        applySecret(patch, "erpnext_api_key", input.erpnext_api_key)
        applySecret(patch, "erpnext_api_secret", input.erpnext_api_secret)
        if (input.request_timeout_ms !== undefined) {
            patch.request_timeout_ms = clampInt(
                input.request_timeout_ms,
                1000,
                120_000,
            )
        }
        if (input.auto_retry_failed !== undefined) {
            patch.auto_retry_failed = input.auto_retry_failed
        }
        if (input.auto_retry_max_attempts !== undefined) {
            patch.auto_retry_max_attempts = clampInt(
                input.auto_retry_max_attempts,
                1,
                100,
            )
        }
        if (input.auto_retry_min_interval_minutes !== undefined) {
            patch.auto_retry_min_interval_minutes = clampInt(
                input.auto_retry_min_interval_minutes,
                1,
                1440,
            )
        }
        if ("last_full_resync_at" in input) {
            patch.last_full_resync_at = input.last_full_resync_at
                ? new Date(input.last_full_resync_at)
                : null
        }
        if ("push_allowlist" in input) {
            const raw = (input.push_allowlist ?? "").trim()
            patch.push_allowlist = raw || null
        }
        if (input.log_retention_days !== undefined) {
            // 0 = keep forever. Cap at ~5 years so a fat-fingered value
            // can't turn the event table into an unbounded PII archive.
            patch.log_retention_days = clampInt(input.log_retention_days, 0, 1825)
        }
        applyInvoiceSettings(patch, input)
        if ("notes" in input) patch.notes = input.notes ?? null
        if ("updated_by_user_id" in input) {
            patch.updated_by_user_id = input.updated_by_user_id ?? null
        }

        if (existing) {
            await this.updateErpnextSettings([{ id: existing.id, ...patch }])
        } else {
            await this.createErpnextSettings([
                { singleton_key: SINGLETON_KEY, ...patch },
            ])
        }

        return this.getSettingsView()
    }


    /**
     * The *effective* config: row values, falling back to env per field.
     */
    async getActiveConfig(): Promise<ActiveConfig> {
        const row = await this.findSettingsRow()

        const erpnext_url =
            (row?.erpnext_url || process.env.ERPNEXT_URL || "").replace(
                /\/$/,
                "",
            ) || null
        const frappe_webhook_secret =
            row?.frappe_webhook_secret || process.env.ERPNEXT_FRAPPE_WEBHOOK_SECRET || null

        const url_source: ActiveConfig["source"]["url"] = row?.erpnext_url
            ? "row"
            : process.env.ERPNEXT_URL
                ? "env"
                : "missing"
        const secret_source: ActiveConfig["source"]["secret"] = row
            ?.frappe_webhook_secret
            ? "row"
            : process.env.ERPNEXT_FRAPPE_WEBHOOK_SECRET
                ? "env"
                : "missing"

        return {
            enable_sync: row?.enable_sync ?? true,
            medusa_product_policy: normalizeProductPolicy(row?.medusa_product_policy),
            sync_doctypes: syncDoctypesOf(row),
            erpnext_url,
            frappe_webhook_secret,
            medusa_public_url: publicUrlOf(row?.medusa_public_url ?? process.env.MEDUSA_BACKEND_URL ?? null),
            erpnext_setup_report: (row?.erpnext_setup_report as SetupReport | null) ?? null,
            request_timeout_ms: row?.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
            auto_retry_failed: row?.auto_retry_failed ?? true,
            auto_retry_max_attempts: row?.auto_retry_max_attempts ?? 5,
            auto_retry_min_interval_minutes:
                row?.auto_retry_min_interval_minutes ?? 15,
            source: { url: url_source, secret: secret_source },
        }
    }

    private async findSettingsRow() {
        const [row] = await this.listErpnextSettings(
            { singleton_key: SINGLETON_KEY },
            { take: 1 },
        )
        return row
    }

    /**
     * Public accessor for the Frappe API token-auth credentials
     * (api_key + api_secret). Pulls from the settings row first, falls
     * back to env vars (matching the pattern in pingErpnext / listing
     * helpers). Used by jobs that need to call Frappe's REST API
     * directly outside the webhook-HMAC path — e.g. the reconciliation
     * cron's missing-on-Frappe customer recovery, which needs to list
     * Frappe Customer emails. Returns `null`s when unconfigured so
     * callers can soft-skip instead of throwing.
     */
    async getApiCredentials(): Promise<{
        api_key: string | null
        api_secret: string | null
    }> {
        const row = await this.findSettingsRow()
        return {
            api_key:
                row?.erpnext_api_key ?? process.env.ERPNEXT_API_KEY ?? null,
            api_secret:
                row?.erpnext_api_secret ??
                process.env.ERPNEXT_API_SECRET ??
                null,
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // ERPNext API client surface (pull / ping / setup)
    //
    // Everything this side asks ERPNext uses Frappe's standard token
    // auth (Authorization: token <api_key>:<api_secret>). Inbound
    // webhooks are verified with the separate `frappe_webhook_secret`.
    // ─────────────────────────────────────────────────────────────────

    /**
     * Ping ERPNext using the stored API key/secret. Hits Frappe's
     * built-in `frappe.auth.get_logged_user`, which echoes the user
     * the keys belong to. Useful as a "are credentials valid?" check
     * from the admin UI.
     */
    async pingErpnext(): Promise<{
        ok: boolean
        url: string | null
        user?: string
        message?: string
        httpStatus?: number
    }> {
        const cfg = await this.getActiveConfig()
        const row = await this.findSettingsRow()
        const apiKey = row?.erpnext_api_key ?? process.env.ERPNEXT_API_KEY ?? null
        const apiSecret =
            row?.erpnext_api_secret ?? process.env.ERPNEXT_API_SECRET ?? null
        if (!cfg.erpnext_url) {
            return { ok: false, url: null, message: "erpnext_url not configured" }
        }
        if (!apiKey || !apiSecret) {
            return {
                ok: false,
                url: cfg.erpnext_url,
                message: "erpnext_api_key / erpnext_api_secret not configured",
            }
        }
        try {
            const res = await fetch(
                `${cfg.erpnext_url}/api/method/frappe.auth.get_logged_user`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `token ${apiKey}:${apiSecret}`,
                    },
                    signal: AbortSignal.timeout(cfg.request_timeout_ms),
                },
            )
            const text = await res.text().catch(() => "")
            if (!res.ok) {
                return {
                    ok: false,
                    url: cfg.erpnext_url,
                    httpStatus: res.status,
                    message: text.slice(0, 300) || `HTTP ${res.status}`,
                }
            }
            // Frappe returns { message: "user@example.com" }
            let user: string | undefined
            try {
                const parsed = JSON.parse(text)
                user = parsed?.message
            } catch {
                /* swallow */
            }
            return { ok: true, url: cfg.erpnext_url, user }
        } catch (err: any) {
            return {
                ok: false,
                url: cfg.erpnext_url,
                message: describeError(err).slice(0, 300),
            }
        }
    }

    /**
     * Generic Frappe REST `GET /api/resource/<doctype>` proxy. Returns
     * the raw body — caller decides how to use it. Caps `limit_page_length`
     * to keep responses manageable from an admin button click.
     */
    async pullDoctype(
        doctype: string,
        params: { limit?: number; fields?: string[]; filters?: any } = {},
    ): Promise<{
        ok: boolean
        items?: any[]
        count?: number
        message?: string
    }> {
        const cfg = await this.getActiveConfig()
        const row = await this.findSettingsRow()
        const apiKey = row?.erpnext_api_key ?? process.env.ERPNEXT_API_KEY ?? null
        const apiSecret =
            row?.erpnext_api_secret ?? process.env.ERPNEXT_API_SECRET ?? null
        if (!cfg.erpnext_url || !apiKey || !apiSecret) {
            return {
                ok: false,
                message: "erpnext_url / api_key / api_secret not all configured",
            }
        }
        const limit = Math.max(1, Math.min(500, params.limit ?? 50))
        const qs = new URLSearchParams()
        qs.set("limit_page_length", String(limit))
        if (params.fields) qs.set("fields", JSON.stringify(params.fields))
        if (params.filters) qs.set("filters", JSON.stringify(params.filters))
        try {
            const res = await fetch(
                `${cfg.erpnext_url}/api/resource/${encodeURIComponent(doctype)}?${qs}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `token ${apiKey}:${apiSecret}`,
                    },
                    signal: AbortSignal.timeout(cfg.request_timeout_ms),
                },
            )
            const text = await res.text().catch(() => "")
            if (!res.ok) {
                return {
                    ok: false,
                    message: `HTTP ${res.status}: ${text.slice(0, 300)}`,
                }
            }
            const parsed = JSON.parse(text)
            const data = Array.isArray(parsed?.data) ? parsed.data : []
            return { ok: true, items: data, count: data.length }
        } catch (err: any) {
            return {
                ok: false,
                message: describeError(err).slice(0, 300),
            }
        }
    }


    /**
     * Catalogue entries in ERPNext that no Medusa product claims yet — what
     * the operator picks from when attaching a product they created here
     * to the one that already exists over there.
     */
    async listUnlinkedCatalogueItems(args: {
        search?: string
        limit?: number
    } = {}): Promise<{ ok: boolean; doctype: string; items: any[]; message?: string }> {
        const doctype = await this.productsDoctype()
        const filters: any[] = []
        if (args.search?.trim()) {
            filters.push(["name", "like", `%${args.search.trim()}%`])
        }
        const limit = Math.min(Math.max(args.limit ?? 20, 1), 200)
        const res = await this.pullDoctype(doctype, {
            filters,
            fields: ["name", "item_name", "disabled"],
            limit: 200,
        })
        if (!res.ok) {
            return { ok: false, doctype, items: [], message: res.message }
        }
        const items: any[] = res.items ?? []
        const names = items.map((i) => String(i.name))
        const linked = names.length
            ? await this.listErpnextLinks(
                  { doctype, medusa_entity: "product", erpnext_name: names } as any,
                  { take: names.length },
              )
            : []
        const taken = new Set((linked as any[]).map((l) => String(l.erpnext_name)))
        return { ok: true, doctype, items: items.filter((i) => !taken.has(String(i.name))).slice(0, limit) }
    }


    /**
     * Attach a Medusa product to an ERPNext catalogue entry: the product
     * remembers the item code so later pushes are allowed and land on the
     * right record, and the link table remembers the pair.
     */
    async linkProductToItem(args: {
        product_id: string
        item_code: string
        scope?: any
    }): Promise<{ ok: boolean; message?: string; item_code?: string; product_id?: string }> {
        const doctype = await this.productsDoctype()
        const itemCode = (args.item_code ?? "").trim()
        if (!args.product_id || !itemCode) {
            return { ok: false, message: "product_id and item_code are both required" }
        }
        const lookup = await this.pullDoctype(doctype, {
            filters: [["name", "=", itemCode]],
            fields: ["name"],
            limit: 1,
        })
        if (!lookup.ok) {
            return { ok: false, message: lookup.message ?? "could not reach ERPNext" }
        }
        if (!(lookup.items ?? [])[0]) {
            return { ok: false, message: `${doctype} "${itemCode}" does not exist` }
        }
        // Must not already belong to a different product — silently
        // stealing a link would leave the other product pointing at a
        // record that no longer names it.
        const existing = await this.findLink(doctype, itemCode, "product")
        if (existing && existing.medusa_id !== args.product_id) {
            return { ok: false, message: `${itemCode} is already linked to ${existing.medusa_id}` }
        }

        const productSvc: any = args.scope?.resolve?.("product")
        if (!productSvc) {
            return { ok: false, message: "product module unavailable in this scope" }
        }
        const product = await productSvc.retrieveProduct(args.product_id)
        await productSvc.updateProducts(args.product_id, {
            metadata: { ...(product.metadata ?? {}), [LINK_KEY]: itemCode },
        })
        await this.recordLink({
            doctype,
            erpnext_name: itemCode,
            medusa_entity: "product",
            medusa_id: args.product_id,
            state: "active",
        })
        return { ok: true, item_code: itemCode, product_id: args.product_id }
    }

    /** Enabled mappings that push this entity, regardless of which event
     *  fires them. Used by the manual push, which has no event of its own. */
    async listEnabledPushMappingsForEntity(entity: string): Promise<any[]> {
        if (!entity) return []
        const rows = await this.listErpnextMappings(
            { enabled: true, medusa_entity: entity },
            { take: 100 },
        )
        return rows.filter((m: any) => m.direction === "push" || m.direction === "both")
    }

    async bulkPush(args: {
        event: string
        items: Array<{ id: string; payload: any }>
        /** Registry entity these items belong to. When given, each item is
         *  pushed through the SAME mapping engine a live event uses, so a
         *  manual push and an automatic one produce identical documents.
         *  Without it the legacy full-payload path is used. */
        entity?: string
        /** The app container, for pushes that number a store invoice. */
        container?: any
    }): Promise<{
        total: number
        success: number
        failed: number
        skipped: number
        results: Array<{
            id: string
            status: ForwardResult["status"]
            error?: string
        }>
    }> {
        const results: Array<{
            id: string
            status: ForwardResult["status"]
            error?: string
        }> = []
        let success = 0
        let failed = 0
        let skipped = 0

        // A manual push used to send the raw record to the unmapped
        // endpoint, so "Push customers" and a live customer.created wrote
        // DIFFERENT documents in ERPNext — the button reported green while
        // writing nothing a mapping had shaped. Route both through the
        // mapping engine; fall back to the old path only when the entity
        // has no mapping at all.
        const mappings = args.entity ? await this.listEnabledPushMappingsForEntity(args.entity) : []

        for (const it of args.items) {
            // Synthetic event id: prefix + entity id + timestamp. Lets the
            // far side dedupe but still distinguishes "live event" from
            // "manual replay" runs.
            const eventId = `manual_push:${args.event}:${it.id}:${Date.now()}`
            let r: ForwardResult
            if (mappings.length) {
                const outcomes: ForwardResult[] = []
                for (const mapping of mappings) {
                    outcomes.push(
                        await this.pushViaMapping({
                            mapping,
                            event: args.event,
                            event_id: `${eventId}:${mapping.id}`,
                            record: it.payload,
                            container: args.container,
                        }),
                    )
                }
                // One failure across several mappings is a failure for the
                // record: the operator needs to see it, not an average.
                r =
                    outcomes.find((o) => !o.ok) ??
                    outcomes.find((o) => o.ok && o.status === "success") ??
                    outcomes[0]
            } else {
                r = await this.forwardEvent({
                    event: args.event,
                    event_id: eventId,
                    data: it.payload,
                })
            }
            if (r.ok && r.status === "success") {
                success++
                results.push({ id: it.id, status: "success" })
            } else if (r.ok && r.status === "skipped") {
                skipped++
                results.push({
                    id: it.id,
                    status: "skipped",
                    error: r.reason,
                })
            } else {
                failed++
                results.push({
                    id: it.id,
                    status: "failed",
                    error: (r as any).error,
                })
            }
        }
        return {
            total: args.items.length,
            success,
            failed,
            skipped,
            results,
        }
    }



    // ─────────────────────────────────────────────────────────────────
    // Doctype + field introspection (Frappe side)
    //
    // Two endpoints feed the admin field-mapper UI:
    //   1. `listFrappeDoctypes` — lists every doctype the operator's
    //      api_key can read; used to populate the right-column doctype
    //      picker.
    //   2. `getDoctypeMeta` — `frappe.client.get_meta` on one doctype;
    //      returns the field list (with label / fieldtype / reqd) so
    //      the right column of the mapper can render the choices.
    // ─────────────────────────────────────────────────────────────────

    /**
     * Enumerate available Frappe doctypes for the mapping picker.
     * Filters out single + child doctypes by default (operators almost
     * always want regular submittable forms). Pass `include_single` to
     * surface Singles like "Medusa Settings".
     */
    async listFrappeDoctypes(options: {
        include_single?: boolean
        limit?: number
        search?: string
    } = {}): Promise<{
        ok: boolean
        items?: Array<{ name: string; module?: string; istable?: number; issingle?: number }>
        message?: string
    }> {
        const cfg = await this.getActiveConfig()
        const apiCreds = await this.frappeApiCreds()
        if (!cfg.erpnext_url || !apiCreds) {
            return { ok: false, message: "erpnext_url / api credentials not configured" }
        }
        const limit = Math.max(1, Math.min(2000, options.limit ?? 500))
        const filters: any[] = []
        if (!options.include_single) {
            filters.push(["issingle", "=", 0])
        }
        if (options.search) {
            filters.push(["name", "like", `%${options.search}%`])
        }
        const qs = new URLSearchParams()
        qs.set("limit_page_length", String(limit))
        qs.set("fields", JSON.stringify(["name", "module", "istable", "issingle"]))
        if (filters.length) qs.set("filters", JSON.stringify(filters))
        qs.set("order_by", "name asc")
        try {
            const res = await fetch(
                `${cfg.erpnext_url}/api/resource/DocType?${qs}`,
                {
                    method: "GET",
                    headers: { Authorization: `token ${apiCreds}` },
                    signal: AbortSignal.timeout(cfg.request_timeout_ms),
                },
            )
            const text = await res.text().catch(() => "")
            if (!res.ok) {
                return {
                    ok: false,
                    message: `HTTP ${res.status}: ${text.slice(0, 300)}`,
                }
            }
            const parsed = JSON.parse(text)
            return {
                ok: true,
                items: Array.isArray(parsed?.data) ? parsed.data : [],
            }
        } catch (err: any) {
            return {
                ok: false,
                message: describeError(err).slice(0, 300),
            }
        }
    }

    /**
     * Fetch the field meta for a single doctype via Frappe's
     * `frappe.client.get_meta` whitelisted method. Returns a flattened
     * list of fields: name, label, fieldtype, reqd, options (for
     * Link/Select), in_list_view, hidden.
     *
     * Cached per-process for 5 minutes — meta rarely changes and the
     * admin field-mapper opens this on every field-picker click.
     */
    async getDoctypeMeta(doctype: string): Promise<{
        ok: boolean
        fields?: Array<{
            fieldname: string
            label: string
            fieldtype: string
            reqd?: number
            options?: string | null
            in_list_view?: number
            hidden?: number
            read_only?: number
            /** Frappe's own default — the autofill uses it to fill a
             *  mandatory field that has no Medusa counterpart. */
            default?: string | null
            /** Present when Frappe derives the value from a Link; such
             *  a field is never writable and the autofill skips it. */
            fetch_from?: string | null
        }>
        message?: string
    }> {
        if (!doctype || !doctype.trim()) {
            return { ok: false, message: "doctype is required" }
        }
        const cacheKey = doctype.trim()
        const cached = _metaCache.get(cacheKey)
        if (cached && cached.expiresAt > Date.now()) {
            return { ok: true, fields: cached.fields }
        }

        const cfg = await this.getActiveConfig()
        const apiCreds = await this.frappeApiCreds()
        if (!cfg.erpnext_url || !apiCreds) {
            return { ok: false, message: "erpnext_url / api credentials not configured" }
        }
        try {
            // Frappe v15+ removed `frappe.client.get_meta`. The supported
            // path is the standard REST resource endpoint, which returns
            // the baseline DocType doc (including `.fields[]`) under
            // `.data`. Works on v14 → v16 and needs no custom
            // whitelisting on the Frappe side.
            //
            // BUT `/api/resource/DocType/<name>` returns ONLY the
            // baseline DocType.fields[] — it does NOT include
            // Custom Field rows (Frappe stores those in a separate
            // `Custom Field` doctype keyed by `dt`). On a customized
            // Customer doctype that means ~35 custom_* fields are
            // missing from the picker — including
            // `custom_is_mithtech_only` and all KYC fields.
            //
            // Fix: fan out two requests and merge. Custom Field wins
            // on fieldname collision (same precedence as Frappe's
            // in-process meta resolver).
            const [baseRes, customRes] = await Promise.all([
                fetch(
                    `${cfg.erpnext_url}/api/resource/DocType/${encodeURIComponent(cacheKey)}`,
                    {
                        method: "GET",
                        headers: { Authorization: `token ${apiCreds}` },
                        signal: AbortSignal.timeout(cfg.request_timeout_ms),
                    },
                ),
                fetch(
                    // NB: "Custom Field" has a space — must be URL-encoded
                    // in the path segment. Node fetch doesn't auto-encode
                    // path segments.
                    `${cfg.erpnext_url}/api/resource/Custom%20Field?` +
                        new URLSearchParams({
                            filters: JSON.stringify([["dt", "=", cacheKey]]),
                            fields: JSON.stringify([
                                "fieldname",
                                "label",
                                "fieldtype",
                                "reqd",
                                "options",
                                "in_list_view",
                                "hidden",
                                "read_only",
                                "default",
                                "fetch_from",
                            ]),
                            limit_page_length: "500",
                        }).toString(),
                    {
                        method: "GET",
                        headers: { Authorization: `token ${apiCreds}` },
                        signal: AbortSignal.timeout(cfg.request_timeout_ms),
                    },
                ),
            ])

            const baseText = await baseRes.text().catch(() => "")
            if (!baseRes.ok) {
                return {
                    ok: false,
                    message: `HTTP ${baseRes.status}: ${baseText.slice(0, 300)}`,
                }
            }
            const baseParsed = JSON.parse(baseText)
            const baseFields: any[] = Array.isArray(baseParsed?.data?.fields)
                ? baseParsed.data.fields
                : Array.isArray(baseParsed?.message?.fields)
                  ? baseParsed.message.fields  // legacy shape (v13 / get_meta)
                  : []

            // Custom Field fan-out is best-effort — a doctype with no
            // Custom Fields returns an empty array; a permission error
            // shouldn't block the whole call (we still have the
            // baseline). Log and continue.
            let customFields: any[] = []
            if (customRes.ok) {
                try {
                    const customParsed = JSON.parse(
                        await customRes.text().catch(() => ""),
                    )
                    customFields = Array.isArray(customParsed?.data)
                        ? customParsed.data
                        : []
                } catch {
                    /* swallow */
                }
            }

            // Filter out layout-only fieldtypes that have no value.
            const NON_VALUE = new Set([
                "Section Break",
                "Column Break",
                "Tab Break",
                "HTML",
                "Heading",
                "Button",
            ])
            // Merge: Custom Field overrides baseline (same precedence
            // as Frappe's runtime `frappe.model.meta.get_meta`).
            const merged = new Map<string, any>()
            for (const f of baseFields) {
                if (f?.fieldname) merged.set(f.fieldname, f)
            }
            for (const f of customFields) {
                if (f?.fieldname) merged.set(f.fieldname, f)
            }
            const trimmed = Array.from(merged.values())
                .filter((f) => f.fieldname && !NON_VALUE.has(f.fieldtype))
                .map((f) => ({
                    fieldname: f.fieldname,
                    label: f.label ?? f.fieldname,
                    fieldtype: f.fieldtype,
                    reqd: f.reqd ?? 0,
                    options: f.options ?? null,
                    in_list_view: f.in_list_view ?? 0,
                    hidden: f.hidden ?? 0,
                    read_only: f.read_only ?? 0,
                    default: f.default ?? null,
                    fetch_from: f.fetch_from ?? null,
                }))
            _metaCache.set(cacheKey, {
                fields: trimmed,
                expiresAt: Date.now() + _META_CACHE_TTL_MS,
            })
            return { ok: true, fields: trimmed }
        } catch (err: any) {
            return {
                ok: false,
                message: describeError(err).slice(0, 300),
            }
        }
    }

    /**
     * The values one ERPNext field will actually accept.
     *
     * A fixed-value pair usually targets a Select or a Link, and the valid
     * answers are that deployment's own data — its Item Groups, its UOMs,
     * its Customer Types if somebody has edited the list. Shipping a guess
     * ("Products", "Nos") would be one client's setup baked into an
     * application every client installs, and it fails Link validation
     * anywhere it does not hold.
     *
     * Select  → the options on the field itself.
     * Link    → the records that exist in the linked DocType right now.
     * Neither → no options, and the UI asks for free text.
     */
    async fieldOptions(
        doctype: string,
        fieldname: string,
    ): Promise<{
        ok: boolean
        fieldtype?: string
        /** Empty when the field takes free text. */
        options?: string[]
        /** Set when a Link has more records than were fetched, so the UI
         *  can say the list is a sample rather than the whole truth. */
        truncated?: boolean
        message?: string
    }> {
        const meta = await this.getDoctypeMeta(doctype)
        if (!meta.ok) return { ok: false, message: meta.message }

        const field = (meta.fields ?? []).find((f) => f.fieldname === fieldname)
        if (!field) {
            return { ok: false, message: `'${fieldname}' is not a field on ${doctype}` }
        }

        if (field.fieldtype === "Select") {
            const options = String(field.options ?? "")
                .split("\n")
                .map((o) => o.trim())
                .filter(Boolean)
            return { ok: true, fieldtype: field.fieldtype, options }
        }

        if (field.fieldtype !== "Link" || !field.options) {
            return { ok: true, fieldtype: field.fieldtype, options: [] }
        }

        const cfg = await this.getActiveConfig()
        const apiCreds = await this.frappeApiCreds()
        if (!cfg.erpnext_url || !apiCreds) {
            return { ok: false, message: "erpnext_url / api credentials not configured" }
        }

        const LIMIT = 200
        try {
            const res = await fetch(
                `${cfg.erpnext_url}/api/resource/${encodeURIComponent(field.options)}?` +
                    new URLSearchParams({
                        fields: JSON.stringify(["name"]),
                        limit_page_length: String(LIMIT + 1),
                        order_by: "name asc",
                    }).toString(),
                {
                    method: "GET",
                    headers: { Authorization: `token ${apiCreds}` },
                    signal: AbortSignal.timeout(cfg.request_timeout_ms),
                },
            )
            const body: any = await res.json()
            if (!res.ok) {
                return {
                    ok: false,
                    message: body?.message ?? `could not read ${field.options}`,
                }
            }
            const names = (body?.data ?? []).map((r: any) => String(r.name))
            return {
                ok: true,
                fieldtype: field.fieldtype,
                options: names.slice(0, LIMIT),
                truncated: names.length > LIMIT,
            }
        } catch (err: any) {
            return { ok: false, message: describeError(err).slice(0, 300) }
        }
    }

    /**
     * Outbound gate, shared by every push path.
     *
     * Reads the allowlist fresh from the settings row rather than
     * caching it — an operator widening or clearing the list during a
     * test session should take effect on the next event, not after a
     * restart.
     */
    async checkPushAllowed(
        record: any,
    ): Promise<PushDecision> {
        const row = await (this as any).findSettingsRow?.()
        return evaluatePush(record, parseAllowlist(row?.push_allowlist))
    }

    private async frappeApiCreds(): Promise<string | null> {
        const row = await (this as any).findSettingsRow?.()
        const apiKey = row?.erpnext_api_key ?? process.env.ERPNEXT_API_KEY ?? null
        const apiSecret =
            row?.erpnext_api_secret ?? process.env.ERPNEXT_API_SECRET ?? null
        if (!apiKey || !apiSecret) return null
        return `${apiKey}:${apiSecret}`
    }

    // ─────────────────────────────────────────────────────────────────
    // Mapping CRUD
    //
    // Thin wrappers over the generated MedusaService accessors that
    // (a) coerce JSON columns into typed shapes and (b) validate the
    // operator-supplied field_mappings array before persisting.
    // ─────────────────────────────────────────────────────────────────

    async listMappings(filter: {
        enabled?: boolean
        medusa_entity?: string
        doctype?: string
    } = {}): Promise<any[]> {
        const where: any = {}
        if (filter.enabled !== undefined) where.enabled = filter.enabled
        if (filter.medusa_entity) where.medusa_entity = filter.medusa_entity
        if (filter.doctype) where.doctype = filter.doctype
        return this.listErpnextMappings(where, { order: { name: "ASC" } })
    }

    async getMapping(id: string): Promise<any | null> {
        const [row] = await this.listErpnextMappings({ id }, { take: 1 })
        return row ?? null
    }

    /** Look up every enabled mapping for one Medusa entity that
     *  subscribes to `eventName`. Used by the push subscriber. */
    async listEnabledPushMappingsForEvent(
        medusa_entity: string,
        eventName: string,
    ): Promise<any[]> {
        const rows = await this.listErpnextMappings(
            { enabled: true, medusa_entity, direction: ["push", "both"] as any },
            { take: 100 },
        )
        return rows.filter((r: any) => {
            if (!Array.isArray(r.events)) return false
            return r.events.includes(eventName)
        })
    }

    /** Look up every enabled mapping that the pull cron should sweep. */
    async listEnabledPullMappings(): Promise<any[]> {
        return this.listErpnextMappings(
            { enabled: true, direction: ["pull", "both"] as any },
            { order: { last_pull_run_at: "ASC" }, take: 200 },
        )
    }

    /**
     * Row-count drift report for a mapping — used by the reconciliation
     * cron's drift detector. Returns `{frappe_count, medusa_count}` so
     * the caller can flag mappings whose two sides have diverged.
     *
     * Scoped to the **customer** mapping deliberately. For the other
     * canonical mappings the two populations aren't apples-to-apples
     * (every Medusa Order is a "Platform Purchase", which the Frappe
     * pull_filter explicitly excludes; Medusa wallet transactions
     * include promo + order-driven rows the Frappe deposit/withdrawal
     * docs never see; etc.) so a naive count diff would emit constant
     * false-positive drift. Those return `null` → the cron skips them.
     *
     * Customer IS comparable: Frappe Customers with
     * `custom_is_mithtech_only=0` correspond 1:1 to Medusa customers
     * that have cleared KYC (`metadata.kyc_fully_approved_at`), which is
     * exactly the population the push subscriber forwards. A persistent
     * gap there means the missing-on-Frappe recovery pass (same cron)
     * has something real to heal.
     */
    async countMappingRows(
        mapping: any,
        container?: any,
    ): Promise<{ frappe_count: number; medusa_count: number } | null> {
        if (mapping?.medusa_entity !== "customer" || !container) return null

        const cfg = await this.getActiveConfig()
        const apiCreds = await this.frappeApiCreds()
        if (!cfg.erpnext_url || !apiCreds) return null

        // ── Frappe side: COUNT(*) with the mapping's pull_filter ──
        const filters = Array.isArray(mapping.pull_filter)
            ? mapping.pull_filter
            : []
        let frappe_count = 0
        try {
            const url =
                `${cfg.erpnext_url}/api/method/frappe.client.get_count` +
                `?doctype=${encodeURIComponent(mapping.doctype)}` +
                `&filters=${encodeURIComponent(JSON.stringify(filters))}`
            const res = await fetch(url, {
                method: "GET",
                headers: { Authorization: `token ${apiCreds}` },
                signal: AbortSignal.timeout(cfg.request_timeout_ms),
            })
            if (!res.ok) return null
            const body: any = await res.json().catch(() => ({}))
            frappe_count = Number(body?.message ?? 0)
        } catch {
            return null
        }

        // ── Medusa side: KYC-approved customers (same gate the push
        // subscriber uses). Bounded list + in-JS filter — metadata
        // key-existence isn't a first-class Medusa query filter, and a
        // count for drift only needs to be approximate. Matches the
        // bound used by the recovery pass in jobs/reconciliation.ts.
        let medusa_count = 0
        try {
            const customerModule: any = container.resolve("customer")
            const all: any[] = await customerModule.listCustomers(
                {},
                { take: 1000 },
            )
            medusa_count = all.filter(
                (c: any) =>
                    (c?.metadata as Record<string, unknown> | undefined)
                        ?.kyc_fully_approved_at,
            ).length
        } catch {
            return null
        }

        return { frappe_count, medusa_count }
    }

    // ─────────────────────────────────────────────────────────────────
    // Detailed reconciliation (breadth): which ids diverge, not just a
    // count delta, for customer / product / order. Compares the stable
    // Medusa id (against the ERPNext `medusa_*_id` the mapping stamps)
    // with a NATURAL-KEY fallback (product handle ↔ item_code, customer
    // email ↔ email_id) — without the fallback, catalog products pulled
    // ERPNext→Medusa (which never stamp their id back onto the Item) all
    // read as "missing_on_frappe". Report-only; bounded + `truncated`.
    // ─────────────────────────────────────────────────────────────────
    private static RECONCILABLE: Record<
        string,
        { list: string; naturalMedusa?: string; naturalErp?: string }
    > = {
        customer: { list: "listCustomers", naturalMedusa: "email", naturalErp: "email_id" },
        product: { list: "listProducts", naturalMedusa: "handle", naturalErp: "item_code" },
        order: { list: "listOrders" }, // id-only: medusa_order_id is the one true key
    }

    async reconcileMapping(
        mapping: any,
        container: any,
        opts?: { limit?: number; sample?: number },
    ): Promise<any> {
        const entity = mapping?.medusa_entity
        const doctype = mapping?.doctype
        const spec = ErpnextModuleService.RECONCILABLE[entity]
        if (!spec || !container) {
            return { entity, doctype, skipped: "not-reconcilable" }
        }
        const limit = opts?.limit ?? 2000
        const sampleCap = opts?.sample ?? 100

        const cfg = await this.getActiveConfig()
        const apiCreds = await this.frappeApiCreds()
        if (!cfg.erpnext_url || !apiCreds) {
            return { entity, doctype, skipped: "not-configured" }
        }

        // Which ERPNext field carries the Medusa id (from the id pair).
        const idPair = (mapping.field_mappings as MappingFieldPair[] | undefined)?.find(
            (p) => p.medusa_path === "id",
        )
        const idField = idPair?.erpnext_field
        if (!idField) return { entity, doctype, skipped: "no-id-pair" }

        // ── Medusa side: {id, natural} bounded ───────────────────────
        const mod: any = container.resolve(spec.list === "listOrders" ? "order" : entity)
        const rows: any[] = (await mod[spec.list]({}, { take: limit })) || []
        const medusaTruncated = rows.length >= limit
        const medusaIds = new Set<string>()
        const medusaNatural = new Set<string>()
        const medusaByKey = rows.map((r: any) => {
            const id = String(r?.id ?? "")
            const nat = spec.naturalMedusa
                ? String(getByPath(r, spec.naturalMedusa) ?? "").toLowerCase()
                : ""
            if (id) medusaIds.add(id)
            if (nat) medusaNatural.add(nat)
            return { id, nat }
        })

        // ── Frappe side: fetch idField (+ natural field) bounded ─────
        const fields = [idField, "name"]
        if (spec.naturalErp && spec.naturalErp !== idField) fields.push(spec.naturalErp)
        const fieldsJson = encodeURIComponent(JSON.stringify(fields))
        const url =
            `${cfg.erpnext_url}/api/resource/${encodeURIComponent(doctype)}` +
            `?fields=${fieldsJson}&limit_page_length=${limit}`
        const res = await fetch(url, {
            method: "GET",
            headers: { Authorization: `token ${apiCreds}` },
            signal: AbortSignal.timeout(cfg.request_timeout_ms),
        })
        if (!res.ok) {
            return { entity, doctype, skipped: `frappe-list-${res.status}` }
        }
        const body: any = await res.json().catch(() => ({}))
        const frappeRows: any[] = Array.isArray(body?.data) ? body.data : []
        const frappeTruncated = frappeRows.length >= limit
        const frappeIds = new Set<string>()
        const frappeNatural = new Set<string>()
        for (const fr of frappeRows) {
            const fid = String(fr?.[idField] ?? "")
            if (fid) frappeIds.add(fid)
            if (spec.naturalErp) {
                const fn = String(fr?.[spec.naturalErp] ?? "").toLowerCase()
                if (fn) frappeNatural.add(fn)
            }
        }

        // ── Diff ─────────────────────────────────────────────────────
        const presentOnFrappe = (m: { id: string; nat: string }) =>
            (m.id && frappeIds.has(m.id)) || (m.nat && frappeNatural.has(m.nat))
        const missing = medusaByKey.filter((m) => !presentOnFrappe(m))
        const matched = medusaByKey.length - missing.length

        // Frappe rows whose stamped medusa id is not a live Medusa id AND
        // whose natural key doesn't match either → orphaned / deleted-in-Medusa.
        const orphans = frappeRows.filter((fr) => {
            const fid = String(fr?.[idField] ?? "")
            if (!fid) return false // Frappe-native row (no medusa id) — not an orphan
            if (medusaIds.has(fid)) return false
            const fn = spec.naturalErp
                ? String(fr?.[spec.naturalErp] ?? "").toLowerCase()
                : ""
            if (fn && medusaNatural.has(fn)) return false
            return true
        })

        return {
            entity,
            doctype,
            medusa_count: medusaByKey.length,
            frappe_count: frappeRows.length,
            matched,
            missing_on_frappe_count: missing.length,
            missing_on_frappe: missing.slice(0, sampleCap).map((m) => m.nat || m.id),
            frappe_orphans_count: orphans.length,
            frappe_orphans: orphans.slice(0, sampleCap).map((fr) => fr.name),
            truncated: medusaTruncated || frappeTruncated,
        }
    }

    /** Run reconcileMapping across every enabled, reconcilable mapping. */
    async reconcileAll(container: any, opts?: { limit?: number; sample?: number }): Promise<any> {
        // All ENABLED mappings regardless of direction — the reconcilable
        // entities (customer/product/order) are push mappings, so a
        // pull-only listing would miss them.
        const mappings: any[] = await this.listMappings({ enabled: true }).catch(() => [])
        const reports: any[] = []
        const seen = new Set<string>()
        for (const m of mappings) {
            if (!ErpnextModuleService.RECONCILABLE[m.medusa_entity]) continue
            if (seen.has(m.medusa_entity)) continue // one report per entity
            seen.add(m.medusa_entity)
            try {
                reports.push(await this.reconcileMapping(m, container, opts))
            } catch (err: any) {
                reports.push({ entity: m.medusa_entity, doctype: m.doctype, error: describeError(err) })
            }
        }
        return { ok: true, generated_at: new Date().toISOString(), reports }
    }

    async saveMapping(input: {
        id?: string
        name: string
        description?: string | null
        enabled?: boolean
        medusa_entity: string
        doctype: string
        direction?: "push" | "pull" | "both"
        events?: string[] | null
        pull_filter?: any[] | null
        pull_page_size?: number
        key_medusa_field: string
        key_erpnext_field?: string
        field_mappings: MappingFieldPair[]
        trigger_preset?: string
        trigger_condition?: string | null
        skip_unchanged?: boolean
        allow_create?: boolean
        allow_update?: boolean
        updated_by_user_id?: string | null
        /**
         * Set only by applyMappingConfig, when this save is ERPNext's copy
         * of the mapping arriving rather than an operator editing it. It
         * does not bypass the gate — it changes what the gate does when it
         * refuses, because throwing at ERPNext would turn its push into a
         * 5xx and a retry loop.
         */
        from_erpnext?: boolean
        /**
         * A sync is its pair. When a mapping for this entity and doctype
         * already exists, fold the new field pairs into it instead of
         * refusing — what the guided setup wants, since the operator is
         * describing the same sync, not asking for a second one.
         */
        merge_into_pair?: boolean
    }) {
        const validated = validateFieldMappings(input.field_mappings ?? [])

        // A mapping goes live only after somebody HERE has tried it. Only
        // the transition is gated: one that is already running keeps
        // running whatever is edited on it, because retro-fitting the rule
        // would stop a working store on the next save of anything.
        const existingRow: any = input.id
            ? (await this.listErpnextMappings({ id: input.id } as any, { take: 1 }))[0]
            : null
        const gateVerdict = mayEnable(existingRow, input as any)
        if (gateVerdict.ok === false) {
            // Held before the branch: reassigning `input` below resets the
            // narrowing that made `reason` reachable, since the verdict was
            // derived from it.
            const refusal = gateVerdict.reason
            if (input.from_erpnext) {
                // ERPNext asked for this. Same rule as first contact:
                // nothing runs here until somebody here has looked at it.
                // Keep every other field it sent, leave it switched off,
                // and say why on the mapping rather than in an exception.
                input = {
                    ...input,
                    enabled: false,
                    attention: "Mapping Required",
                    attention_detail:
                        "ERPNext switched this on, and it has not been rehearsed here. " +
                        "Dry-run it and enable it, or leave it off.",
                } as any
            } else {
                throw new Error(refusal)
            }
        }

        // Reject a malformed condition at SAVE time. Conditions fail
        // closed at run time, so a typo here would silently stop the
        // mapping syncing and the operator would find out days later
        // from a missing record rather than from the form.
        const preset = input.trigger_preset ?? "always"
        const condition =
            input.trigger_condition !== undefined
                ? input.trigger_condition
                : presetCondition(preset)
        const conditionCheck = validateTrigger(condition)
        if (!conditionCheck.ok) {
            throw new Error(`trigger_condition is invalid: ${conditionCheck.error}`)
        }
        const patch: any = {
            name: input.name.trim(),
            description: input.description ?? null,
            enabled: input.enabled ?? true,
            medusa_entity: input.medusa_entity.trim(),
            doctype: input.doctype.trim(),
            direction: input.direction ?? "both",
            events: Array.isArray(input.events) ? input.events.filter(Boolean) : null,
            pull_filter: input.pull_filter ?? null,
            pull_page_size: clampInt(input.pull_page_size ?? 200, 1, 1000),
            key_medusa_field: input.key_medusa_field.trim(),
            key_erpnext_field: (input.key_erpnext_field ?? "name").trim(),
            field_mappings: validated,
            trigger_preset: preset,
            trigger_condition: (condition ?? "").trim() || null,
            skip_unchanged: input.skip_unchanged ?? false,
            allow_create: input.allow_create ?? true,
            allow_update: input.allow_update ?? true,
            updated_by_user_id: input.updated_by_user_id ?? null,
            // Set by the gate above when ERPNext switched on a mapping this
            // side has not rehearsed. Undefined on an ordinary save, and
            // `?? null` would then clear a flag somebody still has to act
            // on, so it is only written when it is actually present.
            ...((input as any).attention !== undefined
                ? {
                      attention: (input as any).attention,
                      attention_detail: (input as any).attention_detail ?? null,
                  }
                : {}),
        }
        // A sync is its pair: one Medusa entity and one DocType, per store,
        // is one mapping, and its identity is derived from that pair so the
        // ERPNext side arrives at the same one without asking.
        const pair = pairUidOf({
            medusa_entity: patch.medusa_entity,
            doctype: patch.doctype,
        })
        if (input.id) {
            const [current] = await this.listErpnextMappings({ id: input.id }, { take: 1 })
            if (current && pairUidOf(current as any) !== pair) {
                throw new Error(
                    "A sync is identified by what it pairs. To keep a different doctype or " +
                        "entity in step, add a new sync instead of changing this one.",
                )
            }
            // `version` counts saves; the enable gate and the drift check
            // read it to tell an edited mapping from a rehearsed one.
            const [updated] = await this.updateErpnextMappings([
                {
                    id: input.id,
                    ...patch,
                    mapping_uid: pair,
                    version: Number(current?.version ?? 1) + 1,
                    // Switched on here, past the gate: whatever was waiting
                    // on a person is done with. A save that sets attention
                    // itself (the gate's refusal above) wins by spreading last.
                    ...(patch.enabled === true && (input as any).attention === undefined
                        ? { attention: null, attention_detail: null }
                        : {}),
                },
            ])
            return updated
        }
        const twin = await this.findMappingByPair(patch.medusa_entity, patch.doctype)
        if (twin) {
            if (!input.merge_into_pair) {
                const err: any = new Error(
                    `"${twin.name}" already keeps ${patch.doctype} in step with ${patch.medusa_entity}. ` +
                        "Edit that sync rather than adding a second one for the same pair.",
                )
                err.code = "pair_exists"
                err.existing_id = twin.id
                throw err
            }
            // Fold: the existing pairs win a collision, the new ones are
            // appended, both sides' events fire, and a one-way sync meeting
            // its opposite becomes two-way. Name and switch stay as they are.
            const [folded] = await this.updateErpnextMappings([
                {
                    id: twin.id,
                    ...patch,
                    name: twin.name,
                    enabled: twin.enabled,
                    direction: mergeDirection(twin.direction, patch.direction),
                    field_mappings: mergeFieldPairs(
                        (twin.field_mappings as MappingFieldPair[]) ?? [],
                        patch.field_mappings,
                    ),
                    events: mergeEvents(twin.events as any, patch.events),
                    mapping_uid: pair,
                    version: Number(twin.version ?? 1) + 1,
                },
            ])
            return { ...folded, merged_into: twin.id }
        }
        const [created] = await this.createErpnextMappings([
            { ...patch, mapping_uid: pair, version: 1 },
        ])
        return created
    }


    /**
     * The mapping that keeps this pair in step, if there is one — by its
     * pair identity first, then by the pair itself for a row that still
     * carries an identity from before the rule.
     */
    async findMappingByPair(
        medusa_entity: string,
        doctype: string,
    ): Promise<any | null> {
        const pair = pairUidOf({ medusa_entity, doctype })
        const [byUid] = await this.listErpnextMappings({ mapping_uid: pair } as any, { take: 1 })
        if (byUid) return byUid
        const candidates = await this.listErpnextMappings(
            { medusa_entity, doctype } as any,
            { take: 20 },
        )
        return (candidates as any[]).find((r) => pairUidOf(r) === pair) ?? null
    }

    /**
     * Delete sync events past the configured retention window.
     *
     * Deletes in batches so a first run against a long-neglected table
     * doesn't hold one enormous transaction open.
     */
    async pruneSyncEvents(): Promise<{
        deleted: number
        retention_days: number
        cutoff: string | null
    }> {
        // Rehearsals go first and go regardless of the retention
        // setting. They are not evidence of anything, they are the
        // noisiest rows in the table while somebody is building a
        // mapping, and a site that turned retention off should not
        // accumulate them forever.
        const TEST_EVENT_RETENTION_DAYS = 1
        const testCutoff = new Date(
            Date.now() - TEST_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        )
        for (let batch = 0; batch < 20; batch += 1) {
            const rehearsals = await this.listErpnextSyncEvents(
                { is_test: true, created_at: { $lt: testCutoff } } as any,
                { take: 500, select: ["id"] } as any,
            )
            if (!rehearsals.length) break
            await this.deleteErpnextSyncEvents(rehearsals.map((r: any) => r.id))
            if (rehearsals.length < 500) break
        }

        const row = await this.findSettingsRow()
        const retentionDays = Number(row?.log_retention_days ?? 180)
        if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
            return { deleted: 0, retention_days: 0, cutoff: null }
        }
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)

        let deleted = 0
        for (let batch = 0; batch < 100; batch += 1) {
            const stale = await this.listErpnextSyncEvents(
                { created_at: { $lt: cutoff } } as any,
                { take: 500, select: ["id"] } as any,
            )
            if (!stale.length) break
            await this.deleteErpnextSyncEvents(stale.map((r: any) => r.id))
            deleted += stale.length
            if (stale.length < 500) break
        }
        return {
            deleted,
            retention_days: retentionDays,
            cutoff: cutoff.toISOString(),
        }
    }

    /**
     * Per-mapping health for the admin list: how many events succeeded,
     * failed or were skipped recently, so an operator can see at a
     * glance which mapping is unhealthy instead of scrolling the log.
     */
    async mappingHealth(windowDays = 30): Promise<
        Record<string, { success: number; failed: number; skipped: number; pending: number }>
    > {
        const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
        const rows = await this.listErpnextSyncEvents(
            { created_at: { $gte: since } } as any,
            { take: 10000, select: ["mapping_id", "status"] } as any,
        )
        const out: Record<string, any> = {}
        for (const r of rows as any[]) {
            const key = r.mapping_id ?? "__unmapped__"
            out[key] ??= { success: 0, failed: 0, skipped: 0, pending: 0 }
            if (r.status in out[key]) out[key][r.status] += 1
        }
        return out
    }


    async deleteMapping(id: string) {
        // What the mapping correlated stays on the synced records, in the
        // link table and in the event log.
        await this.deleteErpnextMappings([id])
        return { ok: true, id }
    }

    /**
     * Seed the canonical mapping set on plugin install / migrate.
     *
     * Idempotent — looks up each canonical entry by `name` and skips
     * if present. Returns `{seeded, skipped}` counts so the caller
     * can log. Safe to call on every server boot (cheap query).
     *
     * Called by the F0+ migration path and by the admin "Reseed
     * canonical mappings" button (F4).
     */
    async seedCanonicalMappings(): Promise<{
        seeded: string[]
        updated: string[]
        errors: { name: string; message: string }[]
    }> {
        const { CANONICAL_MAPPINGS } = await import("./canonical-mappings.js")
        // A sync is its pair, so a shipped default that already exists under
        // any name — including the one ERPNext ships for the same pair — is
        // updated rather than seeded beside it.
        const existing = await this.listErpnextMappings({}, { take: 1000 })
        const existingByPair = new Map<string, any>(
            (existing as any[]).map((r) => [pairUidOf(r), r]),
        )
        const seeded: string[] = []
        const updated: string[] = []
        const errors: { name: string; message: string }[] = []
        for (const m of CANONICAL_MAPPINGS) {
            try {
                // UPSERT: pass the existing id when present so registry
                // changes (new field pairs, fixed pull_filter, etc.)
                // actually propagate. Previously skipped existing
                // rows — which left manually-empty mappings stuck
                // forever after the first save.
                const existingRow = existingByPair.get(
                    pairUidOf({ medusa_entity: m.medusa_entity, doctype: m.doctype }),
                )
                await this.saveMapping({
                    id: existingRow?.id,
                    name: existingRow?.name ?? m.name,
                    description: m.description,
                    enabled: m.enabled,
                    medusa_entity: m.medusa_entity,
                    doctype: m.doctype,
                    direction: m.direction,
                    events: m.events,
                    pull_filter: m.pull_filter,
                    pull_page_size: m.pull_page_size,
                    key_medusa_field: m.key_medusa_field,
                    key_erpnext_field: m.key_erpnext_field,
                    field_mappings: m.field_mappings,
                })
                if (existingRow) {
                    updated.push(m.name)
                } else {
                    seeded.push(m.name)
                }
            } catch (e: any) {
                errors.push({ name: m.name, message: String(e?.message || e) })
            }
        }
        return { seeded, updated, errors }
    }


    /**
     * Lookup helper for the admin Mapping editor's "Suggest field
     * pairs" button. Returns the canonical mapping's `field_mappings`
     * + recommended direction/events/pull_filter for one
     * (entity, doctype) pair so the UI can pre-fill without forcing
     * the operator to remember every store-specific field name.
     *
     * Returns null when no canonical entry matches — the UI then
     * falls back to a heuristic (medusa fieldname ≈ frappe fieldname).
     */
    async suggestMappingForPair(
        entity: string,
        doctype: string,
    ): Promise<{
        ok: true
        canonical: boolean
        suggestion: {
            direction: "push" | "pull" | "both"
            events: string[]
            pull_filter: any
            key_medusa_field: string
            key_erpnext_field: string
            field_mappings: MappingFieldPair[]
        } | null
    }> {
        const { findCanonicalMapping } = await import("./canonical-mappings.js")
        const c = findCanonicalMapping(entity, doctype)
        if (!c) {
            return { ok: true, canonical: false, suggestion: null }
        }
        return {
            ok: true,
            canonical: true,
            suggestion: {
                direction: c.direction,
                events: c.events,
                pull_filter: c.pull_filter,
                key_medusa_field: c.key_medusa_field,
                key_erpnext_field: c.key_erpnext_field,
                field_mappings: c.field_mappings,
            },
        }
    }

    /**
     * Build a complete draft field-map for ANY (entity, doctype) pair.
     *
     * `suggestMappingForPair` above only answers for the six canonical
     * combinations shipped in canonical-mappings.ts. This method works
     * for all 993 doctypes on the connected site: it reads the live
     * field meta, reads the entity's curated dot-paths, and runs the
     * matcher in autofill.ts over the cross-product.
     *
     * Canonical entries are still honoured — they're passed into the
     * matcher as pre-decided pairs and win over any heuristic guess, so
     * picking Customer↔Customer keeps giving exactly the hand-tuned
     * result it did before, with the *unmatched* remainder of the
     * doctype now filled in around it.
     *
     * Network cost is one `getDoctypeMeta` (5-minute per-process cache),
     * so the UI can call this on every doctype change.
     */
    async autofillMapping(args: {
        entity: string
        doctype: string
        direction?: "push" | "pull" | "both"
        mode?: "smart" | "all" | "matched"
        container?: any
    }): Promise<
        | {
              ok: true
              doctype: string
              entity: string
              canonical: boolean
              key_medusa_field: string
              key_erpnext_field: string
              direction: "push" | "pull" | "both"
              events: string[]
              pull_filter: any
              field_mappings: MappingFieldPair[]
              /** Per-row provenance, parallel to field_mappings. The UI
               *  renders these as badges; they are NOT persisted. */
              annotations: AutofillResult["rows"]
              summary: AutofillResult["summary"]
              skipped: AutofillResult["skipped"]
              total_doctype_fields: number
          }
        | { ok: false; message: string }
    > {
        const entityKey = String(args.entity ?? "").trim()
        const doctype = String(args.doctype ?? "").trim()
        if (!entityKey || !doctype) {
            return { ok: false, message: "entity and doctype are required" }
        }

        const descriptor = getMedusaEntity(entityKey)
        if (!descriptor) {
            return { ok: false, message: `unknown Medusa entity '${entityKey}'` }
        }

        const meta = await this.getDoctypeMeta(doctype)
        if (!meta.ok) {
            return {
                ok: false,
                message: meta.message ?? `could not read meta for '${doctype}'`,
            }
        }

        const { findCanonicalMapping } = await import("./canonical-mappings.js")
        const canonicalEntry = findCanonicalMapping(entityKey, doctype)

        // Canonical pairs, keyed by the ERPNext column they write.
        //
        // Two pairs CAN legitimately share a column when they run in
        // opposite directions (Product↔Security maps `handle` on pull
        // and a metadata path on push into the same ERPNext field).
        // Two pairs sharing a column in the SAME direction is a
        // fallback chain written the long way — historically used to
        // survive a metadata rename, relying on empty values being
        // skipped.
        //
        // Keying a plain Map by column silently dropped one of those,
        // and the survivor was whichever came last — which for PAN and
        // Aadhaar was the DEAD renamed key. Auto-mapping Customer would
        // then have replaced a working mapping with one that synced
        // nothing. Merge same-direction collisions into a single
        // `{a || b}` row instead, which is what they always meant.
        const canonicalByField: CanonicalPairLookup = new Map()
        const collisions = new Map<string, string[]>()
        for (const pair of canonicalEntry?.field_mappings ?? []) {
            if (!pair?.erpnext_field) continue
            const key = `${pair.erpnext_field}::${pair.direction ?? "both"}`
            const existing = canonicalByField.get(key)
            if (existing) {
                const paths = collisions.get(key) ?? [existing.medusa_path]
                paths.push(pair.medusa_path)
                collisions.set(key, paths)
                existing.medusa_path = `{${paths
                    .map((p) => (isTemplatePath(p) ? p.replace(/^\{|\}$/g, "") : p))
                    .join(" || ")}}`
                continue
            }
            canonicalByField.set(key, {
                medusa_path: pair.medusa_path,
                transform: pair.transform ?? null,
                direction: pair.direction,
            })
        }

        const direction =
            args.direction ?? canonicalEntry?.direction ?? "both"

        // Match against every field the entity really has, not only the
        // curated ones. The curated list covers a fraction of most models
        // — a Frappe column whose counterpart was never listed could not be
        // suggested at all, however obvious the pairing. Falls back to the
        // curated list when there is no container to introspect with.
        const discovered = args.container
            ? await discoverEntityFields(args.container, entityKey)
            : null
        const entityPaths = discovered?.fields ?? descriptor.paths

        const result = buildAutofill({
            doctypeFields: (meta.fields ?? []) as DoctypeFieldMeta[],
            entityPaths,
            direction,
            canonical: canonicalByField,
            mode: args.mode ?? "smart",
        })

        // Emit only rows that actually carry a source. A mandatory-but-
        // unmatched row is surfaced through `annotations` so the UI can
        // show it as a to-do, but persisting a pair with an empty
        // medusa_path would just be dropped by validateFieldMappings.
        const field_mappings: MappingFieldPair[] = result.rows
            .filter((r) => r.medusa_path)
            .map((r) => {
                const pair: MappingFieldPair = {
                    medusa_path: r.medusa_path,
                    erpnext_field: r.erpnext_field,
                }
                if (r.transform) pair.transform = r.transform
                if (r.transform_push) pair.transform_push = r.transform_push
                if (r.transform_pull) pair.transform_pull = r.transform_pull
                if (r.direction && r.direction !== direction) {
                    pair.direction = r.direction
                }
                if (r.default !== undefined) pair.default = r.default
                return pair
            })

        return {
            ok: true,
            doctype,
            entity: entityKey,
            canonical: Boolean(canonicalEntry),
            key_medusa_field:
                canonicalEntry?.key_medusa_field ?? descriptor.default_key_path,
            key_erpnext_field: canonicalEntry?.key_erpnext_field ?? "name",
            direction,
            events: canonicalEntry?.events ?? descriptor.events,
            pull_filter: canonicalEntry?.pull_filter ?? null,
            field_mappings,
            annotations: result.rows,
            summary: result.summary,
            skipped: result.skipped,
            total_doctype_fields: meta.fields?.length ?? 0,
        }
    }

    /**
     * Dry-run a single mapping against one Medusa record id. Builds
     * the same payload that the push subscriber would send to Frappe,
     * WITHOUT hitting the network. Useful for the admin "Test" button.
     */
    /**
     * A record of this entity to reason about.
     *
     * A real one when the store has any: only a real record shows the
     * shapes an operator will actually meet, empty fields included. One
     * built from the entity's own declared paths otherwise, because a
     * brand-new mapping is exactly when a sample is most useful and
     * exactly when there may be nothing to sample.
     */
    async sampleFor(
        entityKey: string,
        container: any,
        recordId?: string | null,
    ): Promise<{ entity: string; id: string | null; from_record: boolean; data: any }> {
        const entity = getMedusaEntity(entityKey)
        if (!entity) {
            throw new Error(`no registry entry for entity '${entityKey}'`)
        }
        const id = recordId ?? null
        if (id) {
            const record = await entity.fetchById(container, id).catch(() => null)
            if (record) {
                return { entity: entityKey, id, from_record: true, data: record }
            }
        }
        // Built from what the entity says about itself. Typed placeholders
        // rather than empty strings, so a mapping that expects a number
        // gets a number and a transform that parses a date gets a date.
        const data: Record<string, any> = {}
        for (const p of entity.paths ?? []) {
            setByPath(data, p.path, placeholderFor(p))
        }
        return { entity: entityKey, id: null, from_record: false, data }
    }

    /**
     * Remember that this exact mapping was rehearsed.
     *
     * The gate reads `tested_signature`, so recording a pass is what makes
     * a mapping switchable-on. Written straight to the row: a rehearsal is
     * not an edit, and going through saveMapping would bump the version
     * and re-run the very gate this is satisfying.
     */
    async recordMappingTest(mappingId: string, passed: boolean, report?: any): Promise<any> {
        const [row] = await this.listErpnextMappings({ id: mappingId } as any, { take: 1 })
        if (!row) return { ok: false, reason: "no such mapping" }
        await this.updateErpnextMappings({
            id: mappingId,
            tested_signature: passed ? signatureOf(row as any) : null,
            last_test_at: new Date(),
            last_test_status: passed ? "passed" : "failed",
            last_test_report: report ?? null,
        } as any)
        return { ok: true, id: mappingId, passed }
    }

    async dryRunPush(args: {
        mapping_id: string
        /** Omit to rehearse against a sample instead of a real record. */
        record_id?: string | null
        container: any
    }): Promise<{
        ok: boolean
        payload?: Record<string, any>
        key_value?: string
        skipped_fields?: string[]
        message?: string
        /** Reasons this rehearsal did not count as a pass. Empty is a pass. */
        warnings?: string[]
        rehearsal_passed?: boolean
    }> {
        const mapping = await this.getMapping(args.mapping_id)
        if (!mapping) return { ok: false, message: "mapping not found" }
        const entity = getMedusaEntity(mapping.medusa_entity)
        if (!entity) {
            return {
                ok: false,
                message: `medusa entity '${mapping.medusa_entity}' has no registry entry`,
            }
        }
        // A brand-new mapping usually has nothing to point at yet, and
        // that is when rehearsing it matters most. Fall back to a sample
        // built from the entity's own declared paths.
        const record = args.record_id
            ? await entity.fetchById(args.container, args.record_id)
            : (await this.sampleFor(mapping.medusa_entity, args.container)).data
        if (!record) {
            return { ok: false, message: `no ${mapping.medusa_entity} with id ${args.record_id}` }
        }
        const result = applyMapping({
            direction: "push",
            fields: mapping.field_mappings as MappingFieldPair[],
            mappingDirection: mapping.direction as MappingDirection,
            source: record,
            options: await this.transformOptions(),
        })
        if (result.ok === false) {
            return {
                ok: false,
                message: `${result.reason} (field=${result.field ?? "?"})`,
            }
        }
        const keyValue = (record as any)
            ? String(
                  // Walk dot-path on the source to find the key value
                  getByPath(record, mapping.key_medusa_field) ?? "",
              )
            : ""
        // A rehearsal that produced an empty payload, or no key to
        // correlate on, has not shown that the mapping works -- it has
        // shown that it would send nothing. Recording that as a pass would
        // satisfy the enable gate without proving anything, which is worse
        // than having no gate: it looks like a check.
        const fieldCount = Object.keys(result.payload ?? {}).length
        const warnings: string[] = []
        if (!fieldCount) {
            warnings.push(
                "The mapping carried nothing from this record. Check the Medusa paths against " +
                    "the Sample.",
            )
        }
        if (!keyValue) {
            warnings.push(
                `No value at the key path '${mapping.key_medusa_field}', so ERPNext would have ` +
                    "nothing to correlate on.",
            )
        }

        // A mandatory ERPNext field nobody fills does not break here — it
        // breaks on the first real record, with Frappe rejecting the
        // document and the reason buried in a log row. The rehearsal is
        // where that is still cheap to fix, and it is what gates enabling.
        const targetMeta = await this.getDoctypeMeta(mapping.doctype)
        if (targetMeta.ok) {
            const unmet = unmetRequired({
                direction: "push",
                fields: mapping.field_mappings as MappingFieldPair[],
                mappingDirection: mapping.direction as MappingDirection,
                required: (targetMeta.fields ?? [])
                    // A field Frappe derives or defaults is not ours to send.
                    .filter((f) => f.reqd && !f.fetch_from && !f.default)
                    .map((f) => ({ name: f.fieldname, label: f.label })),
            })
            if (unmet.length) {
                warnings.push(
                    `${mapping.doctype} will not accept a record without ` +
                        unmet.map((f) => `'${f.label || f.name}'`).join(", ") +
                        ". Map each one, or give it a fixed value.",
                )
            }
        }
        await this.recordMappingTest(args.mapping_id, warnings.length === 0, {
            payload: result.payload,
            key_value: keyValue,
            skipped_fields: result.skippedFields,
            warnings,
        })
        return {
            ok: true,
            payload: result.payload,
            key_value: keyValue,
            skipped_fields: result.skippedFields,
            warnings,
            rehearsal_passed: warnings.length === 0,
        }
    }

    /**
     * Rehearse the pull half: a Frappe-shaped sample through the mapping,
     * and whether every field the store cannot create this record without
     * is covered by a pair that flows this way.
     *
     * The push rehearsal has asked ERPNext's question since the gate
     * existed. A mapping that only pulls was being refused for ERPNext
     * fields it never writes, and never asked the store's.
     */
    async dryRunPull(args: { mapping_id: string; container: any }): Promise<{
        ok: boolean
        payload?: Record<string, any>
        key_value?: string
        skipped_fields?: string[]
        message?: string
        warnings?: string[]
        rehearsal_passed?: boolean
    }> {
        const mapping = await this.getMapping(args.mapping_id)
        if (!mapping) return { ok: false, message: "mapping not found" }
        const entity = getMedusaEntity(mapping.medusa_entity)
        if (!entity) {
            return { ok: false, message: `medusa entity '${mapping.medusa_entity}' has no registry entry` }
        }
        const fields = mapping.field_mappings as MappingFieldPair[]
        const mappingDirection = mapping.direction as MappingDirection

        // A Frappe row as the pull cron reads it: every field present, keyed
        // by fieldname. Enough to prove the translation and the coverage.
        const meta = await this.getDoctypeMeta(mapping.doctype)
        const sample: Record<string, any> = {}
        for (const f of meta.ok ? (meta.fields ?? []) : []) sample[f.fieldname] = `sample ${f.fieldname}`
        for (const p of fields ?? []) {
            if (p.erpnext_field && !(p.erpnext_field in sample)) sample[p.erpnext_field] = `sample ${p.erpnext_field}`
        }
        sample.name = sample.name ?? "sample-key"
        if (mapping.key_erpnext_field && sample[mapping.key_erpnext_field] === undefined) {
            sample[mapping.key_erpnext_field] = "sample-key"
        }

        const result = applyMapping({
            direction: "pull",
            fields,
            mappingDirection,
            source: sample,
            options: await this.transformOptions(),
        })
        if (result.ok === false) {
            return { ok: false, message: `${result.reason} (field=${result.field ?? "?"})` }
        }
        const keyValue = String(
            (result.payload as any)?.[mapping.key_medusa_field] ?? sample[mapping.key_erpnext_field] ?? "",
        )
        const warnings: string[] = []
        if (!Object.keys(result.payload ?? {}).length) {
            warnings.push("The mapping carries nothing into the store. Check the Frappe fieldnames against the doctype.")
        }
        if (!keyValue) {
            warnings.push(`No value for the key '${mapping.key_erpnext_field}', so nothing could be matched in the store.`)
        }
        // What the store will not create this record without. Discovery says
        // which; the curated fallback has no opinion, and that is reported
        // rather than passed in silence.
        const described = await discoverEntityFields(args.container, mapping.medusa_entity)
        const required = (described.fields ?? [])
            .filter((f: any) => f.required)
            .map((f: any) => ({ name: f.path, label: f.label }))
        if (required.length) {
            const unmet = unmetRequired({ direction: "pull", fields, mappingDirection, required })
            if (unmet.length) {
                warnings.push(
                    `The store will not create a ${entity.label ?? mapping.medusa_entity} without ` +
                        unmet.map((f) => `'${f.label || f.name}'`).join(", ") +
                        ". Map each one from a Frappe field.",
                )
            }
        }
        await this.recordMappingTest(args.mapping_id, warnings.length === 0, {
            direction: "pull",
            payload: result.payload,
            key_value: keyValue,
            skipped_fields: result.skippedFields,
            warnings,
        })
        return {
            ok: true,
            payload: result.payload,
            key_value: keyValue,
            skipped_fields: result.skippedFields,
            warnings,
            rehearsal_passed: warnings.length === 0,
        }
    }

    /** Rehearse every direction this mapping actually uses. */
    async dryRun(args: { mapping_id: string; record_id?: string | null; container: any }): Promise<any> {
        const mapping = await this.getMapping(args.mapping_id)
        if (!mapping) return { ok: false, message: "mapping not found" }
        if (mapping.direction === "pull") return this.dryRunPull(args)
        if (mapping.direction === "push") return this.dryRunPush(args)
        const push = await this.dryRunPush(args)
        if (!push.ok) return push
        const pull = await this.dryRunPull(args)
        if (!pull.ok) return pull
        const warnings = [...(push.warnings ?? []), ...(pull.warnings ?? [])]
        await this.recordMappingTest(args.mapping_id, warnings.length === 0, { push, pull, warnings })
        return {
            ok: true,
            payload: push.payload,
            pull_payload: pull.payload,
            key_value: push.key_value,
            skipped_fields: [...(push.skipped_fields ?? []), ...(pull.skipped_fields ?? [])],
            warnings,
            rehearsal_passed: warnings.length === 0,
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Push via mapping
    //
    // Called by the subscriber. Builds the payload via the engine and
    // logs into erpnext_sync_event tagged with mapping_id.
    // ─────────────────────────────────────────────────────────────────

    /**
     * Push one enriched Medusa record through a specific mapping: policy,
     * trigger, allowlist, transform and the skip-unchanged hash run as
     * before; the transport is paused until Phase 2 (see ./outbound.ts),
     * so the row is recorded as `paused` and nothing leaves.
     */
    async pushViaMapping(args: {
        mapping: any
        event: string
        event_id: string
        record: Record<string, any>
        /** The app container. Needed to number a store invoice; without it
         *  a store that numbers its own invoices cannot push an order. */
        container?: any
    }): Promise<ForwardResult> {
        const cfg = await this.getActiveConfig()
        if (!cfg.enable_sync) {
            return { ok: true, status: "skipped", reason: "sync-disabled" }
        }
        if (!cfg.erpnext_url) {
            await this.upsertEventRow(
                { event: args.event, event_id: args.event_id, data: args.record },
                {
                    status: "skipped",
                    last_error: "ERPNext URL not configured",
                    target_url: null,
                    mapping_id: args.mapping.id,
                },
            )
            return { ok: true, status: "skipped", reason: "not-configured" }
        }
        // ERPNext owns the catalogue. A product invented in the storefront
        // must not quietly become an Item with no cost, stock or purchase
        // history behind it; the operator says whether it may create one,
        // must be attached to an existing one first, or must not travel.
        if (args.mapping.medusa_entity === "product") {
            const verdict = decideProductPush({
                policy: cfg.medusa_product_policy,
                event: args.event,
                linked: isLinked(args.record),
            })
            if (verdict.allow === false) {
                const reason = verdict.reason
                await this.upsertEventRow(
                    { event: args.event, event_id: args.event_id, data: args.record },
                    {
                        status: "skipped",
                        last_error: reason,
                        target_url: null,
                        mapping_id: args.mapping.id,
                    },
                )
                return { ok: true, status: "skipped", reason }
            }
        }

        // The document's own say. ERPNext showed us which way it moves the
        // last time we saw it; a record set to ERPNext → Medusa, or not
        // selected at all, never pushes, whatever the mapping allows.
        if (args.record?.id != null) {
            const [link] = await this.listErpnextLinks(
                { medusa_entity: args.mapping.medusa_entity, medusa_id: String(args.record.id) } as any,
                { take: 1 },
            )
            const verdict = pushAllowedByRecord(link ?? null)
            if (verdict.allowed === false) {
                await this.upsertEventRow(
                    { event: args.event, event_id: args.event_id, data: args.record },
                    {
                        status: "skipped",
                        last_error: verdict.reason,
                        target_url: null,
                        mapping_id: args.mapping.id,
                        action: "skipped",
                    },
                )
                return { ok: true, status: "skipped", reason: verdict.reason }
            }
        }

        // Does this RECORD qualify? `events` decided the event was a
        // candidate; the trigger decides whether this particular record
        // should be in ERPNext at all yet. Used to be a hard-coded KYC
        // check in the forwarder that applied to every customer mapping
        // whether or not the operator wanted it.
        const trigger = evaluateTrigger(args.mapping.trigger_condition, args.record)
        if (!trigger.ok) {
            // A condition that doesn't parse holds everything back
            // rather than releasing it — see trigger.ts. Log loudly so
            // the reason is visible instead of looking like silence.
            await this.upsertEventRow(
                { event: args.event, event_id: args.event_id, data: args.record },
                {
                    status: "failed",
                    last_error: `trigger_condition is invalid: ${trigger.error}`,
                    target_url: null,
                    mapping_id: args.mapping.id,
                },
            )
            return { ok: false, status: "failed", error: `invalid trigger_condition: ${trigger.error}` }
        }
        if (!trigger.matched) {
            await this.upsertEventRow(
                { event: args.event, event_id: args.event_id, data: args.record },
                {
                    status: "skipped",
                    last_error: "trigger_condition not met",
                    target_url: null,
                    mapping_id: args.mapping.id,
                    action: "skipped",
                },
            )
            return { ok: true, status: "skipped", reason: "trigger_not_met" }
        }

        // Same gate as forwardEvent — enforced here too so the mapping
        // path, the admin bulk-push routes and any `medusa exec` script
        // all go through it rather than only the event subscriber.
        const gate = await this.checkPushAllowed(args.record)
        if (!gate.allowed) {
            await this.upsertEventRow(
                { event: args.event, event_id: args.event_id, data: args.record },
                {
                    status: "skipped",
                    last_error: gate.reason,
                    target_url: null,
                    mapping_id: args.mapping.id,
                },
            )
            return { ok: true, status: "skipped", reason: gate.reason }
        }
        const transform = applyMapping({
            direction: "push",
            fields: args.mapping.field_mappings as MappingFieldPair[],
            mappingDirection: args.mapping.direction as MappingDirection,
            source: args.record,
            options: await this.transformOptions(),
        })
        if (transform.ok === false) {
            const err = `${transform.reason} (field=${transform.field ?? "?"})`
            await this.upsertEventRow(
                { event: args.event, event_id: args.event_id, data: args.record },
                {
                    status: "failed",
                    last_error: err,
                    target_url: null,
                    mapping_id: args.mapping.id,
                },
            )
            return { ok: false, status: "failed", error: err }
        }
        const keyValue = getByPath(
            args.record,
            args.mapping.key_medusa_field,
        )
        const keyValueStr =
            keyValue == null || keyValue === ""
                ? null
                : String(keyValue)

        // "Only sync when something actually changed."
        //
        // Medusa events don't carry the previous document, so there is
        // nothing to diff against. What we DO have is the payload we
        // last successfully sent for this record — if the new one
        // hashes the same, nothing a mapped field cares about moved,
        // and the write would be a no-op on the far side.
        //
        // Hashing the payload (not the record) is the point: an
        // unrelated field changing on the customer must not count as a
        // change for a mapping that doesn't sync that field.
        const payloadHash = crypto
            .createHash("sha256")
            .update(
                JSON.stringify({
                    key: keyValueStr,
                    doctype: args.mapping.doctype,
                    payload: transform.payload,
                }),
            )
            .digest("hex")

        if (args.mapping.skip_unchanged && keyValueStr) {
            const [previous] = await this.listErpnextSyncEvents(
                {
                    mapping_id: args.mapping.id,
                    payload_hash: payloadHash,
                    status: "success",
                    // A test run must never be the reason a genuine change
                    // is dropped as a duplicate.
                    is_test: false,
                },
                { take: 1 },
            )
            if (previous) {
                await this.upsertEventRow(
                    { event: args.event, event_id: args.event_id, data: args.record },
                    {
                        status: "skipped",
                        last_error: "payload identical to the last successful push",
                        target_url: null,
                        mapping_id: args.mapping.id,
                        action: "skipped",
                        payload_hash: payloadHash,
                    },
                )
                return { ok: true, status: "skipped", reason: "unchanged" }
            }
        }

        // Delete/cancel events fire AFTER the row is gone, so the record can't
        // be enriched — the payload is just `{ id }` and the natural key
        // (email/handle) is unavailable. Fall back to keying on the Medusa id
        // against whatever ERPNext field the mapping maps the id to (e.g.
        // `medusa_customer_id`), so the far side can still find the doc to
        // disable/cancel. Non-delete events, and deletes whose natural key IS
        // present, are unaffected.
        let effKeyField = args.mapping.key_erpnext_field
        let effKeyValue = keyValueStr
        const isDeleteEvent = /\.(deleted|canceled|cancelled)$/.test(args.event)
        if (isDeleteEvent) {
            // Always key deletes on the stable Medusa id (against the ERPNext
            // `medusa_*_id` field the mapping maps the id to), when available.
            // The natural key (email/handle) requires enriching the record,
            // which is unreliable for a row that's already gone — so a delete
            // must not depend on it.
            const idPair = (args.mapping.field_mappings as MappingFieldPair[]).find(
                (p) => p.medusa_path === "id",
            )
            const rid = args.record?.id
            if (idPair && rid != null) {
                effKeyField = idPair.erpnext_field
                effKeyValue = String(rid)
            }
        }

        // Everything above decided that this record would travel and what
        // it would say. The transport was medusync's, and medusync is
        // retired; until Phase 2 writes over REST the push stops here, on
        // record, so nothing is lost and nothing leaves.
        void effKeyField
        void effKeyValue
        await this.upsertEventRow(
            { event: args.event, event_id: args.event_id, data: args.record },
            {
                status: "skipped",
                last_error: OUTBOUND_PAUSED_MESSAGE,
                target_url: null,
                mapping_id: args.mapping.id,
                action: "paused",
                payload_hash: payloadHash,
            },
        )
        return pausedResult()
    }

    private async markMappingPushOutcome(
        mapping_id: string,
        error: string | null,
    ) {
        try {
            await this.updateErpnextMappings([
                {
                    id: mapping_id,
                    last_push_run_at: new Date(),
                    last_push_error: error,
                },
            ])
        } catch {
            /* non-critical — mapping table touch failure shouldn't bubble */
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Pull via mapping
    // ─────────────────────────────────────────────────────────────────

    /**
     * Run one pull tick for a single mapping. Reads rows modified
     * since `last_pull_at` from Frappe, transforms each via the
     * engine, and upserts into Medusa via the entity registry. Caller
     * is the pull cron in `jobs/pull-from-erpnext.ts`.
     */
    async pullFromMapping(args: {
        mapping: any
        container: any
    }): Promise<{
        ok: boolean
        pulled: number
        upserted: number
        created: number
        updated: number
        skipped: number
        errors: number
        message?: string
    }> {
        const mapping = args.mapping
        const entity = getMedusaEntity(mapping.medusa_entity)
        if (!entity) {
            const msg = `entity '${mapping.medusa_entity}' has no registry entry`
            await this.markMappingPullOutcome(mapping.id, msg)
            return {
                ok: false,
                pulled: 0,
                upserted: 0,
                created: 0,
                updated: 0,
                skipped: 0,
                errors: 0,
                message: msg,
            }
        }
        const cfg = await this.getActiveConfig()
        const apiCreds = await this.frappeApiCreds()
        if (!cfg.erpnext_url || !apiCreds) {
            const msg = "erpnext_url / api credentials not configured"
            await this.markMappingPullOutcome(mapping.id, msg)
            return {
                ok: false,
                pulled: 0,
                upserted: 0,
                created: 0,
                updated: 0,
                skipped: 0,
                errors: 0,
                message: msg,
            }
        }

        // Build filters: time-based watermark + any operator-supplied
        // pull_filter clauses ANDed together.
        const filters: any[] = []
        if (mapping.last_pull_at) {
            const ts = new Date(mapping.last_pull_at).toISOString().slice(0, 19).replace("T", " ")
            filters.push(["modified", ">", ts])
        }
        if (Array.isArray(mapping.pull_filter)) {
            for (const f of mapping.pull_filter) filters.push(f)
        }
        // A selection DocType is pulled through its tick, always: without
        // the field the query fails, which beats a page of unselected rows.
        const underSelection = isSyncDoctype(mapping.doctype, cfg.sync_doctypes)
        const effectiveFilters = withSelectionFilter(filters, mapping.doctype, cfg.sync_doctypes)
        const fields = uniqueFrappeFields(
            mapping.field_mappings as MappingFieldPair[],
            mapping.key_erpnext_field,
            underSelection ? [SELECTION_FIELD] : [],
        )
        const qs = new URLSearchParams()
        qs.set("limit_page_length", String(mapping.pull_page_size ?? 200))
        qs.set("order_by", "modified asc")
        qs.set("fields", JSON.stringify(fields))
        if (effectiveFilters.length) qs.set("filters", JSON.stringify(effectiveFilters))
        let rows: any[] = []
        try {
            const res = await fetch(
                `${cfg.erpnext_url}/api/resource/${encodeURIComponent(mapping.doctype)}?${qs}`,
                {
                    method: "GET",
                    headers: { Authorization: `token ${apiCreds}` },
                    signal: AbortSignal.timeout(cfg.request_timeout_ms),
                },
            )
            const text = await res.text().catch(() => "")
            if (!res.ok) {
                const hint =
                    underSelection && res.status < 500 && !text.includes(SELECTION_FIELD) === false
                        ? " — the medusa_sync field is missing; run Set up ERPNext"
                        : ""
                const msg = `HTTP ${res.status}: ${text.slice(0, 300)}${hint}`
                await this.markMappingPullOutcome(mapping.id, msg)
                return {
                    ok: false,
                    pulled: 0,
                    upserted: 0,
                    created: 0,
                    updated: 0,
                    skipped: 0,
                    errors: 0,
                    message: msg,
                }
            }
            const parsed = JSON.parse(text)
            rows = Array.isArray(parsed?.data) ? parsed.data : []
        } catch (err: any) {
            const msg = describeError(err).slice(0, 300)
            await this.markMappingPullOutcome(mapping.id, msg)
            return {
                ok: false,
                pulled: 0,
                upserted: 0,
                created: 0,
                updated: 0,
                skipped: 0,
                errors: 0,
                message: msg,
            }
        }

        let created = 0
        let updated = 0
        let skipped = 0
        let errors = 0
        let maxModified: string | null = null
        // A product we drafted when its document was unticked comes back
        // published when the document is ticked again.
        const draftedByName = new Map<string, any>()
        if (mapping.medusa_entity === "product" && rows.length) {
            try {
                const drafted = await this.listErpnextLinks(
                    {
                        doctype: mapping.doctype,
                        medusa_entity: mapping.medusa_entity,
                        erpnext_name: rows.map((r: any) => String(r?.name ?? "")).filter(Boolean),
                        state: "drafted",
                    } as any,
                    { take: rows.length },
                )
                for (const l of drafted as any[]) draftedByName.set(String(l.erpnext_name), l)
            } catch {
                /* no republish this tick; the next one will */
            }
        }
        const linksToRecord: Array<{ erpnext_name: string; medusa_id: string; remote_direction: string | null }> = []
        const transformOptions = await this.transformOptions()
        for (const row of rows) {
            if (row?.modified && (!maxModified || row.modified > maxModified)) {
                maxModified = row.modified
            }
            const transform = applyMapping({
                direction: "pull",
                fields: mapping.field_mappings as MappingFieldPair[],
                mappingDirection: mapping.direction as MappingDirection,
                source: row,
                options: transformOptions,
            })
            if (transform.ok === false) {
                skipped += 1
                continue
            }
            const keyValue =
                row?.[mapping.key_erpnext_field] != null
                    ? String(row[mapping.key_erpnext_field])
                    : null
            if (!keyValue) {
                skipped += 1
                continue
            }
            const rowName = row?.name != null ? String(row.name) : keyValue
            const payload = draftedByName.has(rowName)
                ? { ...transform.payload, status: "published" }
                : transform.payload
            const outcome = await entity.upsertByKey(
                args.container,
                mapping.key_medusa_field,
                keyValue,
                payload,
            )
            if (!outcome.ok) {
                errors += 1
                continue
            }
            if (outcome.created) created += 1
            else updated += 1
            if (outcome.id) {
                linksToRecord.push({
                    erpnext_name: rowName,
                    medusa_id: outcome.id,
                    remote_direction: underSelection ? String(row?.[SELECTION_FIELD] ?? "") : null,
                })
            }
        }
        for (const link of linksToRecord) {
            await this.recordLink({
                doctype: mapping.doctype,
                erpnext_name: link.erpnext_name,
                medusa_entity: mapping.medusa_entity,
                medusa_id: link.medusa_id,
                mapping_id: mapping.id,
                state: "active",
                ...(link.remote_direction !== null ? { remote_direction: link.remote_direction } : {}),
            })
        }

        const newWatermark = maxModified
            ? new Date(maxModified.replace(" ", "T") + "Z")
            : mapping.last_pull_at
        try {
            await this.updateErpnextMappings([
                {
                    id: mapping.id,
                    last_pull_at: newWatermark,
                    last_pull_run_at: new Date(),
                    last_pull_error: errors ? `${errors} row(s) failed` : null,
                },
            ])
        } catch {
            /* non-critical */
        }
        return {
            ok: errors === 0,
            pulled: rows.length,
            upserted: created + updated,
            created,
            updated,
            skipped,
            errors,
        }
    }


    // ─────────────────────────────────────────────────────────────────
    // Frappe core Webhooks (ERPNext → Medusa) and the link table
    // ─────────────────────────────────────────────────────────────────

    /** What every Webhook row signs with. Row first, env second. */
    async getFrappeWebhookSecret(): Promise<string | null> {
        const row = await this.findSettingsRow()
        return row?.frappe_webhook_secret || process.env.ERPNEXT_FRAPPE_WEBHOOK_SECRET || null
    }

    /**
     * What the coercing transforms need: the ERPNext site's timezone, so
     * a naive Frappe datetime reads and writes as the site means it, and
     * the region a bare phone number belongs to.
     */
    async transformOptions(): Promise<TransformOptions> {
        const row: any = await this.findSettingsRow()
        return {
            timezone: await this.siteTimezone(),
            phoneRegion: phoneRegionOf(row),
        }
    }

    /**
     * The site's `System Settings.time_zone`, read once per process and
     * kept for an hour. Null — UTC — when ERPNext cannot be asked.
     */
    async siteTimezone(): Promise<string | null> {
        const now = Date.now()
        if (_tzCache && _tzCache.expiresAt > now) return _tzCache.value
        const cfg = await this.getActiveConfig()
        const apiCreds = await this.frappeApiCreds()
        let value: string | null = null
        if (cfg.erpnext_url && apiCreds) {
            try {
                const qs = new URLSearchParams({ doctype: "System Settings", field: "time_zone" })
                const res = await fetch(`${cfg.erpnext_url}/api/method/frappe.client.get_single_value?${qs}`, {
                    method: "GET",
                    headers: { Authorization: `token ${apiCreds}` },
                    signal: AbortSignal.timeout(cfg.request_timeout_ms),
                })
                if (res.ok) {
                    const body: any = await res.json().catch(() => null)
                    const tz = String(body?.message ?? "").trim()
                    if (tz) {
                        // A zone Node does not know is worse than UTC: it throws on every date.
                        new Intl.DateTimeFormat("en-US", { timeZone: tz })
                        value = tz
                    }
                }
            } catch {
                value = null
            }
        }
        _tzCache = { value, expiresAt: now + (value ? 60 * 60 * 1000 : 5 * 60 * 1000) }
        return value
    }

    /**
     * The known values for a Medusa target path — product status, sales
     * channels, shipping profiles — for the mapper's value picker. Null
     * when the path takes free text.
     */
    async medusaOptions(
        entity: string,
        path: string,
        scope: any,
    ): Promise<Array<{ value: string; label: string }> | null> {
        const descriptor = getMedusaEntity(entity)
        const provider = descriptor?.options?.[path]
        if (!provider) return null
        try {
            return await provider(scope)
        } catch (err: any) {
            console.warn(`[erpnext] options for ${entity}.${path} failed:`, describeError(err))
            return []
        }
    }

    /** Which DocType "link this product" searches. */
    private async productsDoctype(): Promise<string> {
        const cfg = await this.getActiveConfig()
        let mappings: any[] = []
        try {
            mappings = await this.listErpnextMappings({ medusa_entity: "product" } as any, { take: 50 })
        } catch {
            mappings = []
        }
        return resolveProductsDoctype(cfg.sync_doctypes, mappings)
    }

    /**
     * One signed, validated webhook body from ERPNext, applied through
     * every enabled pull mapping for its DocType. Always writes a sync row
     * so Frappe's Webhook Request Log and this log tell one story.
     *
     * Answers "skipped" (HTTP 200 at the route) for anything that is not
     * ours to act on: Frappe retries a non-2xx three times, and a retry
     * cannot make a document ours.
     */
    async receiveFrappeWebhook(args: { body: FrappeWebhookBody; scope: any }): Promise<{
        ok: boolean
        status: "success" | "skipped" | "failed"
        event_id: string
        message?: string
        results?: any[]
    }> {
        const body = args.body
        const event_id = frappeEventId(body)
        const eventName = `frappe.${body.event}`
        const cfg = await this.getActiveConfig()
        if (!cfg.enable_sync) {
            return { ok: true, status: "skipped", event_id, message: "sync disabled" }
        }
        const mappings = (await this.listEnabledPullMappings()).filter(
            (m: any) => m.doctype === body.doctype,
        )
        if (!mappings.length) {
            const message = `no enabled pull mapping for ${body.doctype}`
            await this.upsertInboundEventRow(
                { event: eventName, event_id, data: body },
                { status: "skipped", last_error: message, action: "skipped" },
            )
            return { ok: true, status: "skipped", event_id, message }
        }
        const row = await this.upsertInboundEventRow(
            { event: eventName, event_id, data: body },
            { status: "pending", last_error: null },
        )
        try {
            const outcome = await this.applyFrappeEvent(body, args.scope, mappings)
            const failed = outcome.results.filter((r: any) => r.ok === false)
            const message = failed.length
                ? String(failed[0].error ?? "failed").slice(0, ERROR_TRUNCATE)
                : null
            await this.updateErpnextSyncEvents({
                id: row.id,
                status: failed.length ? "failed" : "success",
                succeeded_at: failed.length ? null : new Date(),
                last_error: message,
                action: summariseActions(outcome.results),
                entity_ref: entityRefOf(outcome),
            })
            return failed.length
                ? { ok: false, status: "failed", event_id, message: message ?? undefined, results: outcome.results }
                : { ok: true, status: "success", event_id, results: outcome.results }
        } catch (err: any) {
            const message = describeError(err).slice(0, ERROR_TRUNCATE)
            await this.updateErpnextSyncEvents({ id: row.id, status: "failed", last_error: message })
            return { ok: false, status: "failed", event_id, message }
        }
    }

    /**
     * The executor behind the webhook route, the retry job and the studio's
     * plan: per mapping, decide (./frappe-webhook.ts) and do.
     *
     * The key is the raw value of the mapping's ERPNext key field, as the
     * pull uses it; the entity turns an item code into a handle itself. A
     * draft goes through the link when there is one, so a renamed or
     * re-keyed product is still found.
     */
    private async applyFrappeEvent(
        body: FrappeWebhookBody,
        scope: any,
        mappings?: any[],
    ): Promise<{ via: "frappe"; event: string; results: any[] }> {
        const candidates =
            mappings ??
            (await this.listEnabledPullMappings()).filter((m: any) => m.doctype === body.doctype)
        const results: any[] = []
        const remote_direction =
            SELECTION_FIELD in (body.doc ?? {}) ? String(body.doc[SELECTION_FIELD] ?? "") : undefined
        const transformOptions = await this.transformOptions()
        for (const mapping of candidates) {
            const entity = getMedusaEntity(mapping.medusa_entity)
            if (!entity) {
                results.push({
                    mapping: mapping.name,
                    ok: false,
                    error: `no registry entry for '${mapping.medusa_entity}'`,
                })
                continue
            }
            const link = await this.findLink(body.doctype, body.name, mapping.medusa_entity)
            const plan = planFrappeEvent({ event: body.event, doc: body.doc, mapping, link })
            if (plan.action === "skip") {
                // Remember which way the document now moves, so a push for
                // it reads the current answer.
                if (link && remote_direction !== undefined && remote_direction !== link.remote_direction) {
                    await this.recordLink({
                        doctype: body.doctype,
                        erpnext_name: body.name,
                        medusa_entity: mapping.medusa_entity,
                        medusa_id: link.medusa_id,
                        mapping_id: mapping.id,
                        state: link.state === "drafted" ? "drafted" : "active",
                        remote_direction,
                    })
                }
                results.push({
                    mapping: mapping.name,
                    entity: mapping.medusa_entity,
                    ok: true,
                    action: "skipped",
                    reason: plan.reason,
                })
                continue
            }
            if (plan.action === "draft") {
                if (!entity.disableByKey) {
                    results.push({
                        mapping: mapping.name,
                        entity: mapping.medusa_entity,
                        ok: true,
                        action: "skipped",
                        reason: `inbound delete not supported for entity '${mapping.medusa_entity}'`,
                    })
                    continue
                }
                const out =
                    plan.by === "link"
                        ? await entity.disableByKey(scope, "id", plan.medusa_id)
                        : await entity.disableByKey(
                              scope,
                              mapping.key_medusa_field,
                              mapping.key_medusa_field === "handle" ? handleFromKey(plan.key) : plan.key,
                          )
                const id = out.id ?? (plan.by === "link" ? plan.medusa_id : undefined)
                if (out.ok !== false && id) {
                    await this.recordLink({
                        doctype: body.doctype,
                        erpnext_name: body.name,
                        medusa_entity: mapping.medusa_entity,
                        medusa_id: id,
                        mapping_id: mapping.id,
                        state: "drafted",
                        remote_direction,
                    })
                }
                results.push({
                    mapping: mapping.name,
                    entity: mapping.medusa_entity,
                    ok: out.ok !== false,
                    id,
                    action: out.skipped ? "skipped" : "drafted",
                    reason: out.skipped ? `${plan.reason}; ${out.action ?? "absent"}` : plan.reason,
                    error: out.error,
                })
                continue
            }
            const transform = applyMapping({
                direction: "pull",
                fields: mapping.field_mappings as MappingFieldPair[],
                mappingDirection: mapping.direction as MappingDirection,
                source: body.doc,
                options: transformOptions,
            })
            if (transform.ok === false) {
                results.push({
                    mapping: mapping.name,
                    entity: mapping.medusa_entity,
                    ok: true,
                    action: "skipped",
                    reason: transform.reason,
                })
                continue
            }
            const payload = plan.republish ? { ...transform.payload, status: "published" } : transform.payload
            const outcome = await entity.upsertByKey(scope, mapping.key_medusa_field, plan.key, payload)
            if (outcome.ok && outcome.id) {
                await this.recordLink({
                    doctype: body.doctype,
                    erpnext_name: body.name,
                    medusa_entity: mapping.medusa_entity,
                    medusa_id: outcome.id,
                    mapping_id: mapping.id,
                    state: "active",
                    remote_direction,
                })
            }
            results.push({
                mapping: mapping.name,
                entity: mapping.medusa_entity,
                ok: outcome.ok,
                id: outcome.id,
                action: outcome.ok ? (outcome.created ? "created" : "updated") : undefined,
                reason: plan.reason,
                error: outcome.error,
            })
        }
        return { via: "frappe", event: body.event, results }
    }

    /**
     * Re-apply a stored inbound row. A row from before the Frappe-webhook
     * era carries a medusync envelope, which nothing can apply any more;
     * it is marked poison so the retry job stops cycling it.
     */
    async replayInboundEvent(
        row: any,
        scope: any,
    ): Promise<{ ok: boolean; status: "success" | "failed"; error?: string; poison?: boolean }> {
        const parsed = FrappeWebhookBody.safeParse(row?.payload)
        const attempts = (row?.attempts ?? 0) + 1
        if (!parsed.success) {
            const error = "not replayable: the payload is from the retired medusync protocol"
            await this.updateErpnextSyncEvents({
                id: row.id,
                status: "poison",
                last_error: error,
                attempts,
                last_attempt_at: new Date(),
            })
            return { ok: false, status: "failed", error, poison: true }
        }
        try {
            const outcome = await this.applyFrappeEvent(parsed.data, scope)
            const failed = outcome.results.filter((r: any) => r.ok === false)
            const error = failed.length ? String(failed[0].error ?? "failed").slice(0, ERROR_TRUNCATE) : null
            await this.updateErpnextSyncEvents({
                id: row.id,
                attempts,
                last_attempt_at: new Date(),
                status: failed.length ? "failed" : "success",
                succeeded_at: failed.length ? null : new Date(),
                last_error: error,
                action: summariseActions(outcome.results),
                entity_ref: entityRefOf(outcome),
            })
            return failed.length ? { ok: false, status: "failed", error: error ?? undefined } : { ok: true, status: "success" }
        } catch (err: any) {
            const error = describeError(err).slice(0, ERROR_TRUNCATE)
            await this.updateErpnextSyncEvents({
                id: row.id,
                attempts,
                last_attempt_at: new Date(),
                status: "failed",
                last_error: error,
            })
            return { ok: false, status: "failed", error }
        }
    }

    /**
     * What a webhook body WOULD do, mapping by mapping, without doing it.
     * The studio's "plan inbound". Reads links, writes nothing.
     */
    async planInbound(body: FrappeWebhookBody): Promise<any> {
        let mappings: any[] = []
        try {
            mappings = (await this.listEnabledPullMappings()).filter((m: any) => m.doctype === body.doctype)
        } catch {
            mappings = []
        }
        if (!mappings.length) {
            return {
                action: "skipped",
                reason: `no enabled pull mapping for '${body.doctype}'`,
            }
        }
        const plans: any[] = []
        for (const mapping of mappings) {
            const entity = getMedusaEntity(mapping.medusa_entity)
            if (!entity) {
                plans.push({
                    mapping: mapping.name,
                    action: "error",
                    reason: `no registry entry for '${mapping.medusa_entity}'`,
                })
                continue
            }
            const link = await this.findLink(body.doctype, body.name, mapping.medusa_entity)
            const plan = planFrappeEvent({ event: body.event, doc: body.doc, mapping, link })
            const linkView = link ? { medusa_id: link.medusa_id, state: link.state } : null
            if (plan.action === "skip") {
                plans.push({ mapping: mapping.name, entity: mapping.medusa_entity, action: "skipped", reason: plan.reason, link: linkView })
                continue
            }
            if (plan.action === "draft") {
                plans.push({
                    mapping: mapping.name,
                    entity: mapping.medusa_entity,
                    action: entity.disableByKey ? "disabled" : "skipped",
                    reason: entity.disableByKey
                        ? plan.reason
                        : `inbound delete not supported for entity '${mapping.medusa_entity}'`,
                    key_field: plan.by === "link" ? "id" : mapping.key_medusa_field,
                    key_value: plan.by === "link" ? plan.medusa_id : plan.key,
                    link: linkView,
                })
                continue
            }
            const transform = applyMapping({
                direction: "pull",
                fields: mapping.field_mappings as MappingFieldPair[],
                mappingDirection: mapping.direction as MappingDirection,
                source: body.doc,
                options: await this.transformOptions(),
            })
            if (transform.ok === false) {
                plans.push({ mapping: mapping.name, entity: mapping.medusa_entity, action: "skipped", reason: transform.reason, link: linkView })
                continue
            }
            plans.push({
                mapping: mapping.name,
                entity: mapping.medusa_entity,
                action: "upserted",
                reason: plan.reason,
                key_field: mapping.key_medusa_field,
                key_value: plan.key,
                republish: plan.republish,
                payload: plan.republish ? { ...transform.payload, status: "published" } : transform.payload,
                skipped_fields: transform.skippedFields,
                link: linkView,
            })
        }
        return { action: "planned", mappings: plans }
    }

    private async findLink(doctype: string, erpnext_name: string, medusa_entity: string): Promise<any | null> {
        const [row] = await this.listErpnextLinks(
            { doctype, erpnext_name, medusa_entity } as any,
            { take: 1 },
        )
        return row ?? null
    }

    /**
     * Remember which Medusa record an ERPNext document became. Never
     * throws: the write it describes has already happened, and the next
     * event rebuilds a link that was not recorded.
     */
    private async recordLink(args: {
        doctype: string
        erpnext_name: string
        medusa_entity: string
        medusa_id: string
        mapping_id?: string | null
        state: "active" | "drafted"
        /** The document's `medusa_sync` value as ERPNext showed it. */
        remote_direction?: string | null
    }): Promise<void> {
        try {
            const existing = await this.findLink(args.doctype, args.erpnext_name, args.medusa_entity)
            const now = new Date()
            const direction =
                args.remote_direction !== undefined ? { remote_direction: args.remote_direction } : {}
            if (existing) {
                await this.updateErpnextLinks([
                    {
                        id: existing.id,
                        medusa_id: args.medusa_id,
                        mapping_id: args.mapping_id ?? existing.mapping_id ?? null,
                        state: args.state,
                        ...direction,
                        ...(args.state === "active" ? { last_seen_at: now } : {}),
                    },
                ])
                return
            }
            await this.createErpnextLinks([
                {
                    doctype: args.doctype,
                    erpnext_name: args.erpnext_name,
                    medusa_entity: args.medusa_entity,
                    medusa_id: args.medusa_id,
                    mapping_id: args.mapping_id ?? null,
                    state: args.state,
                    remote_direction: args.remote_direction ?? null,
                    last_seen_at: args.state === "active" ? now : null,
                },
            ])
        } catch (err: any) {
            console.warn("[erpnext] link not recorded:", describeError(err))
        }
    }

    /**
     * "Set up ERPNext": the `medusa_sync` field and the two Webhooks on
     * every selection DocType, over REST, idempotently. See
     * ./erpnext-setup.ts for what is created and why in that order.
     *
     * The secret is generated here when the row has none, so the operator
     * never has to type one anywhere.
     */
    async setupErpnext(args: { fallbackPublicUrl?: string | null } = {}): Promise<{
        ok: boolean
        report?: SetupReport
        message?: string
    }> {
        const cfg = await this.getActiveConfig()
        const creds = await this.frappeApiCreds()
        if (!cfg.erpnext_url) return { ok: false, message: "ERPNext URL is not set" }
        if (!creds) return { ok: false, message: "ERPNext API key and secret are not set" }
        const publicUrl = cfg.medusa_public_url ?? publicUrlOf(args.fallbackPublicUrl ?? null)
        if (!publicUrl) {
            return {
                ok: false,
                message:
                    "Medusa public URL is not set — where ERPNext will POST webhooks (or set MEDUSA_BACKEND_URL)",
            }
        }
        if (!cfg.sync_doctypes.length) return { ok: false, message: "no sync doctypes configured" }

        let row: any = await this.findSettingsRow()
        let secret = cfg.frappe_webhook_secret
        if (!secret) {
            secret = crypto.randomBytes(32).toString("hex")
            if (row) {
                await this.updateErpnextSettings([{ id: row.id, frappe_webhook_secret: secret }])
            } else {
                ;[row] = await this.createErpnextSettings([
                    { singleton_key: SINGLETON_KEY, frappe_webhook_secret: secret },
                ])
            }
        }
        // Creating a Custom Field makes Frappe ALTER the DocType's table on
        // the spot; on a 60k-row Item that is well past the ordinary request
        // timeout, and a request that times out here still completes there.
        const client = makeFrappeClient({
            baseUrl: cfg.erpnext_url,
            token: creds,
            timeoutMs: Math.max(cfg.request_timeout_ms, SETUP_TIMEOUT_MS),
        })
        const report = await runErpnextSetup({
            client,
            doctypes: cfg.sync_doctypes,
            publicUrl,
            secret,
            previous: cfg.erpnext_setup_report,
        })
        if (row) {
            await this.updateErpnextSettings([
                { id: row.id, erpnext_setup_at: new Date(), erpnext_setup_report: report },
            ])
        }
        return { ok: report.ok, report }
    }

    /**
     * The safety net under the webhooks: every active link whose document
     * is no longer ticked — unticked while we were down, trashed, renamed —
     * gets its product drafted. Runs from the hourly reconciliation.
     */
    async reconcileSelection(container: any): Promise<{
        checked: number
        drafted: number
        errors: any[]
        skipped?: string
    }> {
        const report = { checked: 0, drafted: 0, errors: [] as any[] }
        const cfg = await this.getActiveConfig()
        const apiCreds = await this.frappeApiCreds()
        if (!cfg.enable_sync) return { ...report, skipped: "sync-disabled" }
        if (!cfg.erpnext_url || !apiCreds) return { ...report, skipped: "not-configured" }
        let mappings: any[] = []
        try {
            mappings = (await this.listEnabledPullMappings()).filter((m: any) =>
                isSyncDoctype(m.doctype, cfg.sync_doctypes),
            )
        } catch (err: any) {
            report.errors.push({ error: describeError(err) })
            return report
        }
        const PAGE = 100
        for (const mapping of mappings) {
            const entity = getMedusaEntity(mapping.medusa_entity)
            if (!entity?.disableByKey) continue
            let skip = 0
            for (;;) {
                let links: any[] = []
                try {
                    links = await this.listErpnextLinks(
                        { doctype: mapping.doctype, medusa_entity: mapping.medusa_entity, state: "active" } as any,
                        { take: PAGE, skip, order: { id: "ASC" } },
                    )
                } catch (err: any) {
                    report.errors.push({ mapping: mapping.name, error: describeError(err) })
                    break
                }
                if (!links.length) break
                skip += links.length
                const names = links.map((l) => String(l.erpnext_name))
                const qs = new URLSearchParams()
                qs.set("fields", JSON.stringify(["name"]))
                qs.set("filters", JSON.stringify([["name", "in", names], [SELECTION_FIELD, "=", 1]]))
                qs.set("limit_page_length", String(names.length))
                try {
                    const res = await fetch(
                        `${cfg.erpnext_url}/api/resource/${encodeURIComponent(mapping.doctype)}?${qs}`,
                        {
                            method: "GET",
                            headers: { Authorization: `token ${apiCreds}` },
                            signal: AbortSignal.timeout(cfg.request_timeout_ms),
                        },
                    )
                    const text = await res.text().catch(() => "")
                    if (!res.ok) {
                        report.errors.push({ mapping: mapping.name, error: `HTTP ${res.status}: ${text.slice(0, 200)}` })
                        break
                    }
                    const parsed = JSON.parse(text)
                    const still = new Set(
                        (Array.isArray(parsed?.data) ? parsed.data : []).map((r: any) => String(r?.name)),
                    )
                    report.checked += links.length
                    for (const link of links) {
                        if (still.has(String(link.erpnext_name))) continue
                        const out = await entity.disableByKey(container, "id", link.medusa_id)
                        if (out.ok === false) {
                            report.errors.push({ mapping: mapping.name, name: link.erpnext_name, error: out.error })
                            continue
                        }
                        await this.updateErpnextLinks([{ id: link.id, state: "drafted" }])
                        await this.upsertInboundEventRow(
                            {
                                event: "frappe.reconcile",
                                event_id: `frappe:reconcile:${mapping.doctype}:${link.erpnext_name}:${Date.now()}`,
                                data: { doctype: mapping.doctype, name: link.erpnext_name, medusa_id: link.medusa_id },
                            },
                            { status: "success", last_error: null, action: "drafted" },
                        )
                        report.drafted += 1
                    }
                } catch (err: any) {
                    report.errors.push({ mapping: mapping.name, error: describeError(err) })
                    break
                }
                if (links.length < PAGE) break
            }
        }
        return report
    }

    private async markMappingPullOutcome(mapping_id: string, error: string | null) {
        try {
            await this.updateErpnextMappings([
                {
                    id: mapping_id,
                    last_pull_run_at: new Date(),
                    last_pull_error: error,
                },
            ])
        } catch {
            /* non-critical */
        }
    }
}

/** The ERPNext site's timezone, per process. See `siteTimezone`. */
let _tzCache: { value: string | null; expiresAt: number } | null = null

const DEFAULT_PHONE_REGION = "IN"

/** Set up ERPNext waits this long for one call: a Custom Field POST
 *  alters the DocType's table before it answers. */
const SETUP_TIMEOUT_MS = 180_000

/** Two upper-case letters, or the default. */
function phoneRegionOf(row: any): string {
    const raw = String(row?.phone_region ?? "").trim().toUpperCase()
    return /^[A-Z]{2}$/.test(raw) ? raw : DEFAULT_PHONE_REGION
}

// ─── Module-level meta cache ─────────────────────────────────────────
// Field-meta lookups are pure on the Frappe side; cache per-process
// for 5 minutes so the admin field-mapper UI feels snappy.
const _META_CACHE_TTL_MS = 5 * 60 * 1000
const _metaCache = new Map<
    string,
    { fields: any[]; expiresAt: number }
>()

/**
 * Stringify a thrown error INCLUDING its underlying `cause`. Node's
 * undici `fetch` throws a bare `TypeError: fetch failed` and stashes
 * the real reason (ENOTFOUND / ECONNREFUSED / self-signed cert / DNS /
 * connect timeout) on `err.cause`. Recording only `err.message` makes
 * every connection-level failure read "fetch failed" with no clue why;
 * appending the cause turns the sync-event row into an actionable one.
 */
function describeError(err: any): string {
    const base = String(err?.message ?? err)
    const cause = err?.cause
    if (!cause) return base
    const causeMsg = cause?.code
        ? `${cause.code}${cause.message ? `: ${cause.message}` : ""}`
        : String(cause?.message ?? cause)
    return causeMsg && causeMsg !== base ? `${base} (${causeMsg})` : base
}

function maskSecret(s?: string | null) {
    if (!s) return null
    if (s.length <= 8) return "*".repeat(s.length)
    return `${s.slice(0, 3)}…${s.slice(-3)}`
}

/**
 * Postgres 23505. The ORM wraps the driver error, so the code can sit on
 * the error itself or on its cause.
 */
function isUniqueViolation(err: any): boolean {
    return err?.code === "23505" || err?.cause?.code === "23505"
}

function normaliseUrl(input?: string | null) {
    if (input === null) return null
    if (input === undefined || input === "") return undefined as any
    return input.replace(/\/$/, "")
}

/** An absolute http(s) URL without a trailing slash, or null. */
function publicUrlOf(input?: string | null): string | null {
    const raw = String(input ?? "").trim().replace(/\/+$/, "")
    return /^https?:\/\/[^\s/]+/i.test(raw) ? raw : null
}

/** The selection DocTypes on a settings row, never empty. */
function syncDoctypesOf(row: any): SyncDoctype[] {
    const list = normalizeSyncDoctypes(row?.sync_doctypes)
    return list.length ? list : DEFAULT_SYNC_DOCTYPES
}

/** "created" | "updated,skipped" | … — what an inbound apply did, short. */
function summariseActions(results: any[]): string | null {
    const seen: string[] = []
    for (const r of results ?? []) {
        const a = r?.ok === false ? "failed" : r?.action
        if (a && !seen.includes(a)) seen.push(a)
    }
    return seen.length ? seen.join(",").slice(0, 40) : null
}

/** The invoice and storage part of the settings view. Secrets masked. */
function invoiceSettingsView(row: any) {
    return {
        order_document: row?.order_document ?? null,
        invoice_numbering: row?.invoice_numbering === "store" ? "store" : "erpnext",
        store_invoice_prefix: row?.store_invoice_prefix ?? null,
        store_invoice_next: row?.store_invoice_next ?? 1,
        send_invoice_to_store: Boolean(row?.send_invoice_to_store),
        record_payments: Boolean(row?.record_payments),
        invoice_storage: row?.invoice_storage === "s3" ? "s3" : "local",
        invoice_local_dir: row?.invoice_local_dir ?? null,
        s3_bucket: row?.s3_bucket ?? null,
        s3_region: row?.s3_region ?? null,
        s3_endpoint: row?.s3_endpoint ?? null,
        s3_prefix: row?.s3_prefix ?? null,
        s3_force_path_style: Boolean(row?.s3_force_path_style),
        s3_access_key_id_masked: maskSecret(row?.s3_access_key_id),
        s3_secret_access_key_masked: maskSecret(row?.s3_secret_access_key),
    }
}

function applyInvoiceSettings(patch: Record<string, any>, input: SaveSettingsInput) {
    const text = (v: string | null | undefined) => (v ?? "").trim() || null
    if ("order_document" in input) patch.order_document = text(input.order_document)
    if ("invoice_numbering" in input) {
        patch.invoice_numbering = input.invoice_numbering === "store" ? "store" : "erpnext"
    }
    if ("store_invoice_prefix" in input) patch.store_invoice_prefix = text(input.store_invoice_prefix)
    if (input.send_invoice_to_store !== undefined) patch.send_invoice_to_store = input.send_invoice_to_store
    if (input.record_payments !== undefined) patch.record_payments = input.record_payments
    if ("invoice_storage" in input) patch.invoice_storage = input.invoice_storage === "s3" ? "s3" : "local"
    if ("invoice_local_dir" in input) patch.invoice_local_dir = text(input.invoice_local_dir)
    for (const key of ["s3_bucket", "s3_region", "s3_endpoint", "s3_prefix"] as const) {
        if (key in input) patch[key] = text(input[key])
    }
    if (input.s3_force_path_style !== undefined) patch.s3_force_path_style = input.s3_force_path_style
    applySecret(patch, "s3_access_key_id", input.s3_access_key_id)
    applySecret(patch, "s3_secret_access_key", input.s3_secret_access_key)
}

function applySecret(
    patch: Record<string, any>,
    key: string,
    val: string | null | undefined,
) {
    // Empty string = "leave as-is" (UI sends "" when the masked
    // preview was shown but not edited). null = clear. anything else
    // = update.
    if (val === undefined) return
    if (val === "") return
    patch[key] = val // could be null (clear) or a real value
}

function clampInt(n: number, min: number, max: number) {
    if (!Number.isFinite(n)) return min
    return Math.max(min, Math.min(max, Math.floor(n)))
}

/**
 * Validate + sanitise the field_mappings payload coming off the admin
 * form. Drops malformed entries silently — the admin UI rejects them
 * before save, so anything that slips through is a programming error
 * we'd rather not bubble as a 500. Returns the cleaned array ready
 * for JSON-column persistence.
 */
function validateFieldMappings(raw: any[]): MappingFieldPair[] {
    if (!Array.isArray(raw)) return []
    const out: MappingFieldPair[] = []
    for (const r of raw) {
        if (!r || typeof r !== "object") continue
        const medusa_path = String(r.medusa_path ?? "").trim()
        const erpnext_field = String(r.erpnext_field ?? "").trim()
        if (!erpnext_field) continue
        // A fixed-value pair carries no Medusa path by design; every other
        // pair still needs one, or it would silently write nothing.
        const hasConstant = r.constant !== undefined
        if (!medusa_path && !hasConstant) continue
        const pair: MappingFieldPair = {
            medusa_path,
            erpnext_field,
        }
        if (hasConstant) {
            pair.constant = r.constant
        }
        if (r.direction && ["push", "pull", "both"].includes(r.direction)) {
            pair.direction = r.direction
        }
        // A composite template ("{first_name} {last_name}") joins several
        // Medusa fields into one Frappe column and has no inverse. Pin it
        // to push here rather than trusting the form: a row left on
        // "both" would otherwise look pull-capable in the list view and
        // in the dry-run output, even though the engine skips it.
        if (isTemplatePath(medusa_path)) {
            pair.direction = "push"
        }
        if (typeof r.transform === "string" && r.transform.trim()) {
            pair.transform = r.transform.trim()
        }
        if (r.default !== undefined) {
            pair.default = r.default
        }
        if (typeof r.required === "boolean") {
            pair.required = r.required
        }
        out.push(pair)
    }
    return out
}

/**
 * Compute the Frappe `fields` argument for the pull query — only the
 * field names referenced in the mapping (plus `name`, `modified`, and
 * the chosen key field). Avoids over-fetching when the doctype has 50+
 * columns and we only care about 3.
 *
 * Push-only pairs are left out. A pair like `medusa_product_id <- id`
 * carries an id the store owns and names no column on a vanilla ERPNext,
 * so asking Frappe for it fails the whole page with `DataError: Field not
 * permitted in query` — and there would be nothing to read if it answered.
 */
function uniqueFrappeFields(pairs: MappingFieldPair[], keyField: string, extra: string[] = []): string[] {
    const set = new Set<string>(["name", "modified", ...extra])
    if (keyField) set.add(keyField)
    for (const p of pairs ?? []) {
        if (!p?.erpnext_field) continue
        if (String((p as any).direction ?? "").toLowerCase() === "push") continue
        set.add(p.erpnext_field)
    }
    return Array.from(set)
}

/** Internals reachable from the unit tests, which do not boot a container. */
export const __test__ = { uniqueFrappeFields }

export default Module(ERPNEXT_MODULE, {
    service: ErpnextModuleService,
})
