import { Module, MedusaService } from "@medusajs/framework/utils"
import {
    createInventoryItemsWorkflow,
    updateProductVariantsWorkflow,
} from "@medusajs/medusa/core-flows"
import crypto from "crypto"
import { ErpnextSyncEvent } from "./models/sync-event"
import { ErpnextSetting } from "./models/setting"
import { ErpnextMapping } from "./models/mapping"
import { applyMapping, getByPath, isTemplatePath, type MappingDirection, type MappingFieldPair } from "./mapping-engine"
import { listMedusaEntities, getMedusaEntity } from "./registry"
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
import * as envelope from "./envelope"
import { decideConflict, fromCanonical, toCanonical, type CanonicalMapping } from "./mapping-sync"
import { entityRefOf, isWithinEchoWindow } from "./echo"

export const ERPNEXT_MODULE = "erpnext"

// Whitelisted Frappe method that receives Medusa→Frappe pushes. The
// counterpart `medusync` app exposes `medusync.api.receive` (and the
// mapped variant `medusync.api.receive_mapped`); other Frappe apps
// expose their own path, so this is configurable per deployment via
// the `frappe_receive_method` setting (or ERPNEXT_RECEIVE_METHOD env).
// HMAC contract is fixed: sha256 over the raw body, `x-medusa-signature`
// header, `{event, id, data}` payload shape.
const DEFAULT_RECEIVE_METHOD = "medusync.api.receive"

/** Site name used when nothing is configured — what a single-store
 *  install gets, and what the ERPNext side's own default site is called. */
const DEFAULT_SITE_ID = "default"



/** Build the full receive URL from the effective config. The mapped
 *  push appends `_mapped` to the method name. */
function receiveUrl(cfg: ActiveConfig, mapped = false): string {
    const method = `${cfg.frappe_receive_method}${mapped ? "_mapped" : ""}`
    return `${cfg.erpnext_url}/api/method/${method}`
}

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

// Replay protection. Every signed request carries a `ts` (unix seconds) INSIDE
// the HMAC-signed body, so it can't be altered without invalidating the
// signature. Receivers reject anything older/newer than this window — event-id
// idempotency alone stops re-application only until the log row is pruned, so a
// captured request replayed after that would otherwise re-apply.
const REPLAY_WINDOW_SECONDS = 300
const nowTs = () => Math.floor(Date.now() / 1000)
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
}

type ForwardResult =
    | { ok: true; status: "success" | "skipped"; reason?: string; action?: string }
    | { ok: false; status: "failed"; httpStatus?: number; error: string }

type SaveSettingsInput = {
    enable_sync?: boolean
    /** This instance's name on the wire. Must match the Site ID of the
     *  matching Medusync Site record on the ERPNext side. */
    site_id?: string | null
    /** Empty string = unchanged, null = clear, value = update. Same
     *  contract as cashfree-settings to keep the admin UX consistent. */
    erpnext_url?: string | null
    /** Whitelisted Frappe method receiving pushes, e.g.
     *  `medusync.api.receive`. Plain field — empty/null clears back to
     *  the default. */
    frappe_receive_method?: string | null
    /** Medusa→Frappe HMAC secret (legacy column name `webhook_secret`). */
    webhook_secret?: string | null
    /** Frappe→Medusa HMAC secret (F0 — used by the Frappe Webhook
     *  rows seeded by F2; verified by the F1 inbound receiver). */
    frappe_to_medusa_secret?: string | null
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
    /** This instance's name on the wire. One ERPNext can serve several
     *  Medusa stores; every envelope says which one it came from. */
    site_id: string
    erpnext_url: string | null
    webhook_secret: string | null
    /** Whitelisted Frappe method receiving pushes, e.g.
     *  `medusync.api.receive`. Falls back to DEFAULT_RECEIVE_METHOD. */
    frappe_receive_method: string
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
 *   1. The `erpnext_sync_event` log table (every forward attempt).
 *   2. The `erpnext_setting` singleton (URL / secret / toggles).
 *
 * Used by:
 *   - subscribers/erpnext-forward.ts   → forwardEvent on every Medusa event
 *   - api/admin/erpnext/events/...     → list + retry endpoints
 *   - api/admin/erpnext/settings/...   → masked GET + POST save
 *
 * Failure handling: HTTP failures are caught and logged on the row;
 * the caller never sees a thrown error, so order placement on the
 * storefront is never blocked by an ERPNext outage.
 */
class ErpnextModuleService extends MedusaService({
    ErpnextSyncEvent,
    ErpnextSetting,
    ErpnextMapping,
}) {
    // ─────────────────────────────────────────────────────────────────
    // Sync-event surface
    // ─────────────────────────────────────────────────────────────────

    /**
     * Forward an enriched event to ERPNext. Always logs a row (unless
     * sync is globally disabled). Never throws — returns a structured
     * result the caller can choose to ignore.
     */
    async forwardEvent(args: ForwardArgs): Promise<ForwardResult> {
        const cfg = await this.getActiveConfig()

        if (!cfg.enable_sync) {
            // Hard-disabled — don't even log a row. Mirrors the Frappe
            // side's behaviour where webhooks.receive returns
            // {ok: true, skipped: "sync disabled"} without writing a
            // Medusa Sync Log row. Keeps the table clean during long
            // maintenance windows.
            return { ok: true, status: "skipped", reason: "sync-disabled" }
        }

        if (!cfg.erpnext_url || !cfg.webhook_secret) {
            // Soft-skip path: log so it's visible in the admin list and
            // can be replayed once ERPNext is configured.
            await this.upsertEventRow(args, {
                status: "skipped",
                last_error: "ERPNEXT URL / webhook secret not configured",
                target_url: null,
            })
            return { ok: true, status: "skipped", reason: "not-configured" }
        }

        // Last gate before the record leaves Medusa. Applies to the
        // legacy full-payload path as well as the mapping path, so
        // there's no way to reach ERPNext around it.
        const gate = await this.checkPushAllowed(args.data)
        if (!gate.allowed) {
            await this.upsertEventRow(args, {
                status: "skipped",
                last_error: gate.reason,
                target_url: null,
            })
            return { ok: true, status: "skipped", reason: gate.reason }
        }

        const targetUrl = receiveUrl(cfg)
        // Was this record just written BY ERPNext? Then what we are about
        // to send is ERPNext's own change coming home; tag it so the far
        // side drops it instead of applying it again and bouncing it back.
        const cause = await this.echoCauseFor(args.data?.__entity_ref ?? null)
        const body = JSON.stringify(
            envelope.build({
                event: args.event,
                event_id: args.event_id,
                site_id: cfg.site_id,
                data: args.data,
                correlation_id: cause?.correlation_id ?? null,
                echo_of: cause?.origin ?? null,
            }),
        )
        const signature = crypto
            .createHmac("sha256", cfg.webhook_secret)
            .update(body)
            .digest("hex")

        const row = await this.upsertEventRow(args, {
            status: "pending",
            last_error: null,
            target_url: targetUrl,
        })

        try {
            const res = await fetch(targetUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-medusa-signature": signature,
                    "x-medusa-event-id": args.event_id,
                },
                body,
                signal: AbortSignal.timeout(cfg.request_timeout_ms),
            })

            if (!res.ok) {
                const text = await res.text().catch(() => "")
                const errMsg = `${res.status}: ${text}`.slice(0, ERROR_TRUNCATE)
                await this.updateErpnextSyncEvents({
                    id: row.id,
                    status: "failed",
                    last_error: errMsg,
                })
                return {
                    ok: false,
                    status: "failed",
                    httpStatus: res.status,
                    error: errMsg,
                }
            }

            await this.updateErpnextSyncEvents({
                id: row.id,
                status: "success",
                succeeded_at: new Date(),
            })
            return { ok: true, status: "success" }
        } catch (err: any) {
            const errMsg = describeError(err).slice(0, ERROR_TRUNCATE)
            await this.updateErpnextSyncEvents({
                id: row.id,
                status: "failed",
                last_error: errMsg,
            })
            return { ok: false, status: "failed", error: errMsg }
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Return-request last-mile (Medusa → Frappe method call)
    //
    // A customer/admin return request is NOT a doctype upsert, so it
    // doesn't go through a mapping. It maps to the whitelisted method
    // `create_pending_return`, which is registered in the Frappe handler
    // registry under event `order.return_requested`. We POST the same
    // signed envelope `forwardEvent` uses, to the same `medusync.api.receive`
    // endpoint (which dispatches registered handlers), so the request rides
    // the full transport hardening: HMAC, replay window, idempotency, and a
    // Medusync Log row on the Frappe side.
    //
    // Unlike `forwardEvent`, we read and return the response BODY: the Frappe
    // handler legitimately returns `{status:"skipped", reason:"no submitted
    // Delivery Note..."}` (200, not an error) when nothing has shipped yet,
    // and the admin must see that reason rather than a silent success. So the
    // caller (the admin route) gets `{ok, httpStatus, result}` where `result`
    // is the Frappe envelope's own result object.
    async requestReturn(
        medusaOrderId: string,
        items: Array<{ sku: string; qty: number; reason?: string }>,
    ): Promise<{
        ok: boolean
        httpStatus?: number
        status: string
        result?: any
        error?: string
    }> {
        const cfg = await this.getActiveConfig()
        if (!cfg.enable_sync) {
            return { ok: true, status: "skipped", result: { reason: "sync-disabled" } }
        }
        if (!cfg.erpnext_url || !cfg.webhook_secret) {
            return {
                ok: false,
                status: "not-configured",
                error: "ERPNext URL / webhook secret not configured",
            }
        }

        const event_id = `medusa:order.return_requested:${medusaOrderId}:${nowTs()}`
        const body = JSON.stringify({
            event: "order.return_requested",
            id: event_id,
            data: { medusa_order_id: medusaOrderId, items },
            ts: nowTs(),
        })
        const signature = crypto
            .createHmac("sha256", cfg.webhook_secret)
            .update(body)
            .digest("hex")
        const targetUrl = receiveUrl(cfg)

        try {
            const res = await fetch(targetUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-medusa-signature": signature,
                    "x-medusa-event-id": event_id,
                },
                body,
                signal: AbortSignal.timeout(cfg.request_timeout_ms),
            })
            const parsed = await res.json().catch(() => ({}) as any)
            // The Frappe envelope nests the handler's own return under `result`.
            const inner = (parsed as any)?.result ?? parsed
            if (!res.ok) {
                return {
                    ok: false,
                    httpStatus: res.status,
                    status: "failed",
                    result: inner,
                    error: `${res.status}: ${JSON.stringify(inner).slice(0, ERROR_TRUNCATE)}`,
                }
            }
            return {
                ok: true,
                httpStatus: res.status,
                status: String((inner as any)?.status ?? "success"),
                result: inner,
            }
        } catch (err: any) {
            return {
                ok: false,
                status: "failed",
                error: describeError(err).slice(0, ERROR_TRUNCATE),
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // F1 — inbound receiver (Frappe→Medusa)
    //
    // Counterpart of `forwardEvent` (Medusa→Frappe). Frappe-side
    // `Webhook` rows (seeded by F2 via /admin/erpnext/seed-frappe-
    // webhooks) sign every body with `frappe_to_medusa_secret` and
    // POST to /admin/erpnext/inbound. This method:
    //   1. Verifies the HMAC.
    //   2. Logs an `erpnext_sync_event` row with direction='inbound'.
    //   3. Dispatches to an entity-specific handler.
    //   4. Marks the row success / failed and returns the result so
    //      the route handler can pick a sensible HTTP status code.
    //
    // Idempotency: dedupe is on `event_id` (passed in the body as
    // `frappe:<doctype>:<name>:<modified>` by the Frappe Webhook
    // Jinja body template). A retry with the same id just bumps
    // attempts on the existing row.
    // ─────────────────────────────────────────────────────────────────

    async receiveInbound(args: {
        rawBody: Buffer
        signatureHeader: string | null
        eventIdHeader: string | null
        /** Request scope from the route — used by handlers to resolve
         *  other Medusa modules (customer, product, cashfree_wallet).
         *  Optional so the retry cron can replay without a scope. */
        scope?: any
    }): Promise<{
        ok: boolean
        status: "success" | "skipped" | "failed" | "unauthorized" | "bad_request"
        message?: string
        event?: string
        event_id?: string
        result?: any
    }> {
        const cfg = await this.getActiveConfig()
        if (!cfg.enable_sync) {
            return {
                ok: true,
                status: "skipped",
                message: "sync_disabled",
            }
        }
        const row = await this.findSettingsRow()
        const secret =
            row?.frappe_to_medusa_secret ??
            process.env.ERPNEXT_FRAPPE_TO_MEDUSA_SECRET ??
            null
        if (!secret) {
            return {
                ok: false,
                status: "unauthorized",
                message:
                    "frappe_to_medusa_secret not configured. Set it in Settings before Frappe sends webhooks.",
            }
        }
        // Frappe Webhook signs body with HMAC-SHA256 and base64-encodes
        // the digest into `X-Frappe-Webhook-Signature`. Our admin UI
        // also accepts `x-medusa-signature` for manual testing.
        const expected = crypto
            .createHmac("sha256", secret)
            .update(args.rawBody)
            .digest("base64")
        const expectedHex = crypto
            .createHmac("sha256", secret)
            .update(args.rawBody)
            .digest("hex")
        const provided = (args.signatureHeader ?? "").trim()
        const sigOk =
            provided.length > 0 &&
            (safeEq(provided, expected) || safeEq(provided, expectedHex))
        if (!sigOk) {
            // Diagnostic: log enough about the mismatch to triage
            // signature failures without leaking the secret itself.
            // Common causes when this fires for real Frappe webhooks:
            //   - Frappe Webhook row has no `Content-Type:
            //     application/json` header → Express body parser
            //     skips parsing AND preserveRawBody verify hook never
            //     fires → rawBody falls back to empty `{}` (body_len:
            //     2). The seedFrappeWebhooks blueprint pins the
            //     header explicitly to prevent this.
            //   - Secret rotated on one side but not the other —
            //     re-run /admin/erpnext/seed-frappe-webhooks to
            //     re-PUT every row with the current secret.
            const bodySha = crypto
                .createHash("sha256")
                .update(args.rawBody)
                .digest("hex")
                .slice(0, 16)
            console.warn(
                "[erpnext-inbound] signature mismatch",
                JSON.stringify({
                    body_len: args.rawBody.length,
                    body_sha256_prefix: bodySha,
                    provided_sig: provided.slice(0, 16) + "...",
                    expected_b64: expected.slice(0, 16) + "...",
                }),
            )
            return {
                ok: false,
                status: "unauthorized",
                message: "Invalid signature.",
            }
        }
        let body: any = {}
        try {
            body = JSON.parse(args.rawBody.toString("utf8") || "{}")
        } catch {
            return {
                ok: false,
                status: "bad_request",
                message: "Body is not valid JSON.",
            }
        }

        // One envelope shape carries every kind of traffic; `kind` says
        // what the body holds. A v1 body has no `kind` and is recognised
        // by its shape, so a Frappe app that has not been upgraded yet
        // keeps working through a rolling deploy. See ./envelope.ts.
        const env = envelope.parse(body)
        const event = env.event
        const event_id = String(args.eventIdHeader ?? env.event_id ?? "").trim()
        const data = env.data ?? body ?? {}
        if (!event) {
            return {
                ok: false,
                status: "bad_request",
                message: "Missing `event` in body.",
            }
        }
        if (!event_id) {
            return {
                ok: false,
                status: "bad_request",
                message:
                    "Missing event_id (set in body as event_id, id, or in the x-medusa-event-id header)",
            }
        }
        // Replay window. `ts` lives inside the signed body, so a captured
        // request can't be re-dated without breaking the signature. A v2
        // sender always stamps one, so its absence there is itself
        // suspicious; a v1 body predates the field and is let through on
        // event-id idempotency alone.
        if (env.version >= envelope.ENVELOPE_VERSION && env.ts == null) {
            return {
                ok: false,
                status: "unauthorized",
                message: "Missing timestamp — request rejected (replay window).",
            }
        }
        if (!envelope.isFresh(env)) {
            return {
                ok: false,
                status: "unauthorized",
                message: "Stale timestamp — request rejected (replay window).",
            }
        }

        // Our own change coming home. ERPNext stamps `echo_of` on anything
        // it sends that was caused by a write WE made; applying it would
        // write the same values again and emit the same event again, which
        // is how a sync loop starts once the round trip has crossed a
        // worker and no in-request guard survives.
        if (envelope.isEcho(env, await this.ourSiteIds())) {
            return {
                ok: true,
                status: "skipped",
                message: "echo of our own change",
                event,
                event_id,
            }
        }

        const origin =
            env.origin_system && env.origin_site_id
                ? envelope.originRef(env.origin_system, env.origin_site_id)
                : "erpnext:" + DEFAULT_SITE_ID

        // Log the row as pending FIRST so a crashing handler still
        // leaves an audit trail.
        const eventRow = await this.upsertInboundEventRow(
            { event, event_id, data },
            {
                status: "pending",
                last_error: null,
                origin,
                correlation_id: env.correlation_id,
                site_id: env.origin_site_id,
            },
        )
        try {
            const result =
                env.kind === envelope.KIND_MAPPING
                    ? await this.dispatchMappingConfig(env)
                    : await this.dispatchInbound(event, data, event_id, args.scope)
            await this.updateErpnextSyncEvents([
                {
                    id: eventRow.id,
                    status: "success",
                    succeeded_at: new Date(),
                    last_error: null,
                    // Which record this write touched, so the push it
                    // triggers a moment later can recognise itself as an
                    // echo and say so. See echoCauseFor.
                    entity_ref: entityRefOf(result),
                },
            ])
            return { ok: true, status: "success", event, event_id, result }
        } catch (err: any) {
            const errMsg = describeError(err).slice(0, ERROR_TRUNCATE)
            await this.updateErpnextSyncEvents([
                {
                    id: eventRow.id,
                    status: "failed",
                    last_error: errMsg,
                },
            ])
            return {
                ok: false,
                status: "failed",
                event,
                event_id,
                message: errMsg,
            }
        }
    }

    /**
     * A mapping configuration arrived from ERPNext. Both systems hold the
     * same mapping under one uid; the higher version wins and ERPNext
     * wins a tie, so this either applies the change or records why it
     * refused. Never throws — a refused mapping is a normal outcome.
     */
    private async dispatchMappingConfig(env: envelope.ParsedEnvelope): Promise<any> {
        const canon = (env.mapping ?? {}) as CanonicalMapping
        if (env.event.endsWith(".deleted")) {
            return { via: "mapping-config", ...(await this.disableMappingConfig(canon.uid)) }
        }
        return { via: "mapping-config", ...(await this.applyMappingConfig(canon)) }
    }

    /**
     * Dispatch the inbound payload to a handler. Each handler is a
     * thin shim that resolves the right Medusa module and applies
     * an idempotent upsert. NEW events should be added here — the
     * receiver returns `no_handler_for_event` (HTTP 200, status=
     * skipped) for unknown events so Frappe doesn't retry them.
     */
    private async dispatchInbound(
        event: string,
        data: any,
        event_id: string,
        scope?: any,
    ): Promise<any> {
        if (event === "ping") return { pong: true, echo: data }

        // Generic, mapping-driven inbound. Resolve the enabled pull/both
        // mapping(s) for this event or Frappe doctype and apply them via the
        // registry — the same path the pull cron uses (create/update), plus
        // safe soft-delete for `.deleted`/`.canceled`. Only when NO mapping
        // matches do we fall through to the legacy domain handlers below, so
        // sites with a registered handler pack keep working unchanged.
        const viaMapping = await this._applyInboundViaMappings(
            event,
            data,
            event_id,
            scope,
        )
        if (viaMapping.matched) return viaMapping.result

        switch (event) {
            // ── Inventory (ERPNext owns stock; one-way) ─────────────
            case "inventory.level.set":
                return this._handleInventoryLevelSet(data, event_id, scope)

            // ── Post-order reverse path (ERPNext → order metadata) ──
            case "order.fulfilled":
                return this._mergeOrderMeta(scope, data?.medusa_order_id, "erp_fulfillment", {
                    status: data?.status ?? null,
                    items: data?.items ?? [],
                    lr_no: data?.lr_no ?? null,
                    transporter: data?.transporter ?? null,
                    vehicle: data?.vehicle_no ?? null,
                    dispatched_at: data?.dispatched_at ?? null,
                })
            case "order.tracking":
                return this._mergeOrderMeta(scope, data?.medusa_order_id, "tracking", {
                    awb: data?.awb_number ?? null,
                    carrier: data?.carrier ?? null,
                    carrier_service: data?.carrier_service ?? null,
                    url: data?.tracking_url ?? null,
                    status: data?.tracking_status ?? null,
                    delivered: !!data?.delivered,
                })
            case "order.invoiced":
                return this._mergeOrderMeta(scope, data?.medusa_order_id, "invoice", {
                    number: data?.invoice_number ?? null,
                    date: data?.invoice_date ?? null,
                    total: data?.grand_total ?? null,
                    currency: data?.currency ?? null,
                    status: data?.status ?? null,
                })
            case "order.returned":
                return this._mergeOrderMeta(scope, data?.medusa_order_id, "return", {
                    status: data?.status ?? null,
                    items: data?.items ?? [],
                    return_against: data?.return_against ?? null,
                    received_at: data?.received_at ?? null,
                })
            case "order.refunded":
                return this._mergeOrderMeta(scope, data?.medusa_order_id, "refund", {
                    credit_note: data?.credit_note ?? null,
                    amount: data?.amount ?? null,
                    date: data?.date ?? null,
                    currency: data?.currency ?? null,
                    status: data?.status ?? null,
                    reason: data?.reason ?? null,
                })

            // ── Pricing + B2B (ERPNext → Medusa) ────────────────────
            case "variant.price.set":
                return this._handleVariantPrice(scope, data)
            case "variant.meta.set":
                return this._handleVariantMeta(scope, data)
            case "variant.tier_price.set":
                return this._handleVariantTierPrice(scope, data)
            case "customer.group.set":
                return this._handleCustomerGroup(scope, data)

            // ── Customer events ─────────────────────────────────────
            case "customer.created":
            case "customer.updated":
                return this._handleCustomerUpserted(data, event_id, scope)

            // ── Wallet events (credits) ─────────────────────────────
            case "wallet.deposit.received":
                return this._handleWalletCredit(data, event_id, scope, {
                    kind: "deposit",
                    note: "Frappe Wallet Deposit submit",
                })
            case "share.sale.completed":
                return this._handleWalletCredit(data, event_id, scope, {
                    kind: "share_sale",
                    note: "Frappe Security Purchase submit (customer-sell)",
                    amount_override:
                        Number(data?.qty ?? 0) * Number(data?.rate ?? 0),
                })

            // ── Wallet events (debits) ──────────────────────────────
            case "wallet.withdrawal.posted":
                return this._handleWalletDebit(data, event_id, scope, {
                    kind: "withdrawal",
                    note: "Frappe Wallet Withdrawal submit",
                })

            // ── Wallet event reversals ──────────────────────────────
            case "wallet.deposit.canceled":
            case "wallet.withdrawal.canceled":
            case "share.sale.canceled":
                return this._handleWalletReverse(data, event_id, scope, {
                    event,
                })

            // ── Security catalog ────────────────────────────────────
            case "security.updated":
                return this._handleSecurityUpserted(data, event_id, scope)

            // ── Backend / Direct order creation + cancellation ─────
            // Storefront orders (source=Platform Purchase) ARE NOT
            // dispatched here — Frappe Webhook 9's condition filters
            // them out. We only see operator-created Security Sales
            // (Backend Order / Direct) that need to materialize in
            // Medusa as a real Order.
            case "order.placed":
                return this._handleOrderPlaced(data, event_id, scope)
            case "order.canceled":
                return this._handleOrderCanceled(data, event_id, scope)
            default:
                return {
                    skipped: true,
                    reason: "no_handler_for_event",
                    event,
                }
        }
    }

    /**
     * Generic inbound apply. Finds the enabled pull/both mapping(s) whose
     * Frappe doctype (or event name) matches the incoming webhook and runs
     * them through the registry — create/update via `upsertByKey`, and safe
     * soft-delete via `disableByKey` for `.deleted`/`.canceled` events. This
     * is the domain-neutral counterpart to the pull cron; the legacy
     * hardcoded handlers are only used when nothing matches here.
     *
     * Returns `{ matched: false }` when no mapping applies, so the caller
     * falls through to the legacy switch.
     */
    private async _applyInboundViaMappings(
        event: string,
        data: any,
        _event_id: string,
        scope?: any,
    ): Promise<{ matched: boolean; result?: any }> {
        let mappings: any[] = []
        try {
            mappings = await this.listEnabledPullMappings()
        } catch {
            return { matched: false }
        }
        if (!mappings.length) return { matched: false }

        const doctype = String(data?.doctype ?? "").trim()
        const lower = event.toLowerCase()
        const isDelete =
            lower.endsWith(".deleted") ||
            lower.endsWith(".canceled") ||
            lower.endsWith(".cancelled") ||
            lower.endsWith(".trashed")

        const candidates = mappings.filter(
            (m: any) =>
                (doctype && m.doctype === doctype) ||
                (Array.isArray(m.events) && m.events.includes(event)),
        )
        if (!candidates.length) return { matched: false }

        const results: any[] = []
        for (const mapping of candidates) {
            const entity = getMedusaEntity(mapping.medusa_entity)
            if (!entity) {
                results.push({
                    mapping: mapping.name,
                    error: `no registry entry for '${mapping.medusa_entity}'`,
                })
                continue
            }
            const rawKey =
                data?.[mapping.key_erpnext_field] != null
                    ? String(data[mapping.key_erpnext_field])
                    : null

            // Run the mapping up front so we have both the translated payload
            // AND the translated key. The lookup key must be the TRANSFORMED
            // value (e.g. item_code "ABC" → handle "abc"): keying on the raw
            // ERPNext value misses the existing row and creates a duplicate on
            // update, or no-ops on delete.
            const transform = applyMapping({
                direction: "pull",
                fields: mapping.field_mappings as MappingFieldPair[],
                mappingDirection: mapping.direction as MappingDirection,
                source: data,
            })
            const mappedKey =
                transform.ok !== false
                    ? (transform.payload as any)?.[mapping.key_medusa_field]
                    : undefined
            const effKey =
                mappedKey != null && mappedKey !== "" ? String(mappedKey) : rawKey
            if (!effKey) {
                results.push({
                    mapping: mapping.name,
                    skipped: `no value for key field '${mapping.key_erpnext_field}'`,
                })
                continue
            }

            if (isDelete) {
                if (!entity.disableByKey) {
                    results.push({
                        mapping: mapping.name,
                        skipped: `inbound delete not supported for entity '${mapping.medusa_entity}'`,
                    })
                    continue
                }
                const out = await entity.disableByKey(
                    scope,
                    mapping.key_medusa_field,
                    effKey,
                )
                results.push({
                    mapping: mapping.name,
                    entity: mapping.medusa_entity,
                    ok: out.ok,
                    id: out.id,
                    action: out.action,
                    error: out.error,
                })
                continue
            }

            if (transform.ok === false) {
                results.push({ mapping: mapping.name, skipped: transform.reason })
                continue
            }
            const outcome = await entity.upsertByKey(
                scope,
                mapping.key_medusa_field,
                effKey,
                transform.payload,
            )
            results.push({
                mapping: mapping.name,
                entity: mapping.medusa_entity,
                ok: outcome.ok,
                id: outcome.id,
                created: outcome.created,
                error: outcome.error,
            })
        }
        return { matched: true, result: { via: "mapping", event, results } }
    }

    // ─────────────────────────────────────────────────────────────────
    // Handler implementations (F3-handlers)
    //
    // Each handler is best-effort: a missing customer or product
    // surfaces as `{skipped: true, reason}` so Frappe's 3-attempt
    // retry doesn't churn on data-shape mismatches. Real errors are
    // re-thrown so the receiver marks the row status=failed and the
    // retry cron picks it up.
    // ─────────────────────────────────────────────────────────────────

    private async _resolveCustomerByEmail(scope: any, email: string) {
        if (!email || !scope) return null
        const customerModule = scope.resolve("customer")
        const matches = await customerModule.listCustomers(
            { email },
            { take: 1 },
        )
        return matches?.[0] ?? null
    }

    /**
     * Walk a Frappe payload looking for a corresponding Medusa Customer.
     *
     * Wallet Deposit / Withdrawal doctypes don't natively carry the
     * customer's email — only the Customer link (e.g. "MANOJ MITHAJAL
     * BHAT"). The Frappe-side seeded webhook templates were updated
     * (frappe-webhooks.ts) to resolve the email at fire time via
     * `frappe.db.get_value('Customer', doc.customer, 'email_id')`.
     * On older tenants (pre-reseed) the email field is still empty
     * — this resolver fills the gap by asking Frappe directly via
     * REST when only the Customer name is present in the payload.
     *
     * Resolution order:
     *   1. `data.customer_email` direct (cheap, no Frappe round-trip)
     *   2. `data.customer` (Frappe Customer name) → REST lookup of
     *      Customer.email_id → Medusa customer by email
     *
     * Returns the Medusa Customer object, or null if neither path
     * yields a match (caller logs + skips).
     */
    private async _resolveCustomerForWalletEvent(scope: any, data: any) {
        const direct = String(data?.customer_email ?? "").trim()
        if (direct) {
            const c = await this._resolveCustomerByEmail(scope, direct)
            if (c) return c
        }

        const frappeCustomerName = String(data?.customer ?? "").trim()
        if (!frappeCustomerName) return null

        try {
            const cfg = await this.getActiveConfig()
            const creds = await this.getApiCredentials()
            if (!cfg.erpnext_url || !creds.api_key || !creds.api_secret) {
                return null
            }
            const url =
                `${cfg.erpnext_url}/api/resource/Customer/` +
                `${encodeURIComponent(frappeCustomerName)}?fields=` +
                encodeURIComponent(JSON.stringify(["email_id"]))
            const res = await fetch(url, {
                method: "GET",
                headers: {
                    Authorization: `token ${creds.api_key}:${creds.api_secret}`,
                },
                signal: AbortSignal.timeout(cfg.request_timeout_ms ?? 30000),
            })
            if (!res.ok) return null
            const body: any = await res.json().catch(() => ({}))
            const resolvedEmail = String(body?.data?.email_id ?? "").trim()
            if (!resolvedEmail) return null
            return await this._resolveCustomerByEmail(scope, resolvedEmail)
        } catch {
            return null
        }
    }

    /**
     * Set a Medusa inventory level from an ERPNext stock update. One-way:
     * ERPNext owns stock. Keyed by sku == ERPNext item_code. Unknown sku →
     * logged skip (not an error). Single stock location (or
     * INVENTORY_LOCATION_ID). Modules resolved by string, like the other
     * inbound handlers.
     */
    /**
     * Post-order reverse path: additively merge a sub-object into a Medusa
     * order's metadata (fulfilment / tracking / invoice). Native Medusa
     * fulfillment is unsupported in this setup, so the order metadata is the
     * source of truth (matches the existing dispatched/delivered lifecycle).
     * Never clobbers other metadata keys.
     */
    private async _mergeOrderMeta(
        scope: any,
        medusaOrderId: string | null | undefined,
        key: string,
        value: Record<string, any>,
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const id = String(medusaOrderId ?? "").trim()
        if (!id) return { skipped: true, reason: "missing medusa_order_id" }
        const orderSvc: any = scope.resolve("order")
        const [order] = await orderSvc.listOrders(
            { id },
            { take: 1, select: ["id", "metadata"] },
        )
        if (!order) return { skipped: true, reason: `no order ${id}` }
        const metadata = { ...(order.metadata || {}), [key]: value }
        await orderSvc.updateOrders([{ id, metadata }])
        return { ok: true, order_id: id, key }
    }

    /**
     * Pricing (ERPNext → Medusa, ERPNext wins): set/overwrite a variant's
     * price for one currency. Amounts arrive in rupees (major) and are stored
     * in minor units (paise), matching this store's price convention. A
     * deleted price / expired validity clears it so no stale rate shows.
     */
    private async _handleVariantPrice(scope: any, data: any): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const sku = String(data?.sku ?? "").trim()
        if (!sku) return { skipped: true, reason: "missing sku" }
        const productSvc: any = scope.resolve("product")
        const [variant] = await productSvc.listProductVariants({ sku }, { take: 1 })
        if (!variant) return { skipped: true, reason: `no variant for sku ${sku}` }
        const currency = String(data?.currency ?? "inr").toLowerCase()
        // Expired / soft-deleted price → clear it (no stale rate on the store).
        const nowMs = new Date().getTime()
        const validTo = data?.valid_upto ? new Date(data.valid_upto).getTime() : null
        const expired = validTo != null && !Number.isNaN(validTo) && validTo < nowMs
        const clear = !!data?.deleted || expired || data?.amount == null
        const amountMinor = clear
            ? null
            : Math.round((Number(data.amount) || 0) * 100)
        // A variant created via the service call (not the product workflow) has
        // no price set, and the update workflow can't update prices that don't
        // exist. So create + link a price set the first time (same pattern as
        // the inventory item), then use the workflow for subsequent updates.
        const query: any = scope.resolve("query")
        const { data: vrows } = await query.graph({
            entity: "variant",
            fields: ["id", "price_set.id"],
            filters: { id: variant.id },
        } as any)
        const priceSetId = vrows?.[0]?.price_set?.id
        if (!priceSetId) {
            if (clear) return { ok: true, skipped: true, reason: "no price to clear" }
            const pricingSvc: any = scope.resolve("pricing")
            const [ps] = await pricingSvc.createPriceSets([
                { prices: [{ amount: amountMinor, currency_code: currency }] },
            ])
            const link: any = scope.resolve("link")
            await link.create({
                product: { variant_id: variant.id },
                pricing: { price_set_id: ps.id },
            })
            return { ok: true, sku, amount_minor: amountMinor, currency, created: true }
        }
        await updateProductVariantsWorkflow(scope).run({
            input: {
                product_variants: [
                    { id: variant.id, prices: clear ? [] : [{ amount: amountMinor, currency_code: currency }] },
                ] as any,
            },
        })
        return { ok: true, sku, amount_minor: amountMinor, currency, cleared: clear }
    }

    /** MOQ / other commerce metadata → merge into variant.metadata. */
    private async _handleVariantMeta(scope: any, data: any): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const sku = String(data?.sku ?? "").trim()
        if (!sku) return { skipped: true, reason: "missing sku" }
        const productSvc: any = scope.resolve("product")
        const [variant] = await productSvc.listProductVariants(
            { sku },
            { take: 1, select: ["id", "metadata"] },
        )
        if (!variant) return { skipped: true, reason: `no variant for sku ${sku}` }
        const patch: Record<string, any> = {}
        if (data?.moq != null) patch.moq = Number(data.moq)
        if (data?.pack_size != null) patch.pack_size = Number(data.pack_size)
        await productSvc.updateProductVariants(variant.id, {
            metadata: { ...(variant.metadata || {}), ...patch },
        })
        return { ok: true, sku, metadata: patch }
    }

    /**
     * B2B tier price (ERPNext → Medusa, ERPNext wins). An Item Price on a
     * tier-mapped price list becomes a standalone `b2b_pricing` PriceTier row
     * — `min_quantity: 1`, product+variant scoped, keyed on the customer tier.
     * Values arrive in rupees and are stored in MINOR units (paise), matching
     * the engine's convention (see b2b_pricing service: "values are in paise").
     * `deleted` (or a null amount) removes the row so no stale tier price
     * lingers. We NEVER set `price_list_id` (that mirror belongs to the
     * engine's own tier→price-list projection) and never touch DynamicRule.
     * The engine resolves via `getPriceTiers(product_id, {tier_ids})`, which is
     * why `product_id` must be set — a variant-only row would never resolve.
     */
    private async _handleVariantTierPrice(scope: any, data: any): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const sku = String(data?.sku ?? "").trim()
        const tierCode = String(data?.tier_code ?? "").trim()
        if (!sku) return { skipped: true, reason: "missing sku" }
        if (!tierCode) return { skipped: true, reason: "missing tier_code" }

        const productSvc: any = scope.resolve("product")
        const [variant] = await productSvc.listProductVariants(
            { sku },
            { take: 1, select: ["id"] },
        )
        if (!variant) return { skipped: true, reason: `no variant for sku ${sku}` }

        // The engine queries PriceTier by product_id, so resolve it.
        const query: any = scope.resolve("query")
        const { data: vrows } = await query.graph({
            entity: "variant",
            fields: ["id", "product.id"],
            filters: { id: variant.id },
        } as any)
        const productId = vrows?.[0]?.product?.id
        if (!productId) return { skipped: true, reason: `no product for variant ${variant.id}` }

        // Resolve the tier by its stable code (the Price List custom field
        // holds the code; ERPNext is the mapping's editor).
        const tierSvc: any = scope.resolve("customer_tier")
        const [tier] = await tierSvc.listCustomerTiers({ code: tierCode }, { take: 1 })
        if (!tier) return { skipped: true, reason: `no customer_tier for code ${tierCode}` }

        // Quantity bracket: ERPNext `packing_unit` (units-per-pack) becomes the
        // ladder's `min_quantity` — multiple Item Prices per (item, list) at
        // different packing_units form a volume ladder. Default 1 (single).
        const minQty = Math.max(1, Math.trunc(Number(data?.min_quantity) || 1))
        const maxQty =
            data?.max_quantity != null && Number(data.max_quantity) > 0
                ? Math.trunc(Number(data.max_quantity))
                : null

        const b2b: any = scope.resolve("b2b_pricing")
        // Idempotency: one row per (variant, tier, min_quantity) — so a ladder
        // of brackets coexists, and each bracket updates/deletes independently.
        const [existing] = await b2b.listPriceTiers(
            { variant_id: variant.id, customer_tier_id: tier.id, min_quantity: minQty },
            { take: 1 },
        )

        if (data?.deleted || data?.amount == null) {
            if (existing) {
                await b2b.deletePriceTiers(existing.id)
                return { ok: true, sku, tier: tierCode, min_quantity: minQty, deleted: true }
            }
            return { ok: true, skipped: true, reason: "no tier price to clear" }
        }

        const valueMinor = Math.round((Number(data.amount) || 0) * 100)
        if (existing) {
            // MedusaService update* takes a single { id, ...fields } object (or
            // an array of them) — NOT a positional (id, data) pair. Passing the
            // id positionally made it the data payload, leaving id undefined and
            // throwing `B2bPriceTier with id "" not found` on every update.
            await b2b.updatePriceTiers([
                { id: existing.id, value: valueMinor, max_quantity: maxQty },
            ])
            return { ok: true, sku, tier: tierCode, min_quantity: minQty, value_minor: valueMinor, updated: true }
        }
        await b2b.createPriceTiers([
            {
                product_id: productId,
                variant_id: variant.id,
                customer_tier_id: tier.id,
                min_quantity: minQty,
                max_quantity: maxQty,
                value: valueMinor,
                is_percentage: false,
                region_id: null,
                rule_id: null,
                // price_list_id intentionally null — see method doc.
            },
        ])
        return { ok: true, sku, tier: tierCode, min_quantity: minQty, value_minor: valueMinor, created: true }
    }

    /** B2B: ensure a Medusa customer group by name and add the customer to it. */
    private async _handleCustomerGroup(scope: any, data: any): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const groupName = String(data?.group ?? "").trim()
        if (!groupName) return { skipped: true, reason: "no group" }
        const custSvc: any = scope.resolve("customer")
        let customer: any = null
        const id = String(data?.medusa_customer_id ?? "").trim()
        if (id) [customer] = await custSvc.listCustomers({ id }, { take: 1 })
        const email = String(data?.email ?? "").toLowerCase()
        if (!customer && email)
            [customer] = await custSvc.listCustomers({ email }, { take: 1 })
        if (!customer) return { skipped: true, reason: "no customer" }
        let [group] = await custSvc.listCustomerGroups({ name: groupName }, { take: 1 })
        if (!group) {
            const [g] = await custSvc.createCustomerGroups([{ name: groupName }])
            group = g
        }
        try {
            await custSvc.addCustomerToGroup({
                customer_id: customer.id,
                customer_group_id: group.id,
            })
        } catch {
            /* already a member — idempotent */
        }
        return { ok: true, customer: customer.id, group: group.id, name: groupName }
    }

    private async _handleInventoryLevelSet(
        data: any,
        event_id: string,
        scope: any,
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const sku = String(data?.sku ?? "").trim()
        const quantity = Number(data?.quantity)
        if (!sku || !Number.isFinite(quantity)) {
            return { skipped: true, reason: "missing sku or quantity" }
        }
        const inv: any = scope.resolve("inventory")
        let [item] = await inv.listInventoryItems({ sku }, { take: 1 })
        if (!item) {
            // No inventory item yet for this sku. If a product variant with the
            // sku exists (e.g. an ERPNext-origin product), create + link an
            // inventory item so stock lands and the storefront can sell it.
            // (Variants created via the service call — not the product
            // workflow — don't auto-create their inventory item.)
            const productSvc: any = scope.resolve("product")
            const [variant] = await productSvc.listProductVariants(
                { sku },
                { take: 1 },
            )
            if (!variant) {
                return { skipped: true, reason: `no inventory item or variant for sku ${sku}` }
            }
            const { result } = await createInventoryItemsWorkflow(scope).run({
                input: { items: [{ sku, title: sku }] },
            })
            item = result[0]
            if (!variant.manage_inventory) {
                await productSvc.updateProductVariants(variant.id, {
                    manage_inventory: true,
                })
            }
            const link: any = scope.resolve("link")
            await link.create({
                product: { variant_id: variant.id },
                inventory: { inventory_item_id: item.id },
                data: { required_quantity: 1 },
            })
        }
        const locSvc: any = scope.resolve("stock_location")
        const locId =
            process.env.INVENTORY_LOCATION_ID ||
            (await locSvc.listStockLocations({}, { take: 1 }))?.[0]?.id
        if (!locId) {
            return { skipped: true, reason: "no stock location" }
        }
        const [level] = await inv.listInventoryLevels(
            { inventory_item_id: item.id, location_id: locId },
            { take: 1 },
        )
        if (level) {
            await inv.updateInventoryLevels([
                { inventory_item_id: item.id, location_id: locId, stocked_quantity: quantity },
            ])
        } else {
            await inv.createInventoryLevels([
                { inventory_item_id: item.id, location_id: locId, stocked_quantity: quantity },
            ])
        }
        return { ok: true, sku, quantity, location_id: locId, inventory_item_id: item.id }
    }

    private async _handleCustomerUpserted(
        data: any,
        event_id: string,
        scope: any,
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const email = String(data?.email_id ?? "").toLowerCase()
        if (!email) {
            return { skipped: true, reason: "missing_email" }
        }
        const customer = await this._resolveCustomerByEmail(scope, email)
        const customerModule = scope.resolve("customer")
        const meta = {
            kyc_status: data?.custom_kyc_status ?? null,
            kyc_verified_on: data?.custom_kyc_verified_on ?? null,
            pan: data?.pan ?? null,
            gstin: data?.gstin ?? null,
            dob: data?.custom_dob ?? null,
            client_id: data?.custom_client_id ?? null,
            // Frappe retired `custom_is_polemarch_customer` in v0_26_0.
            // Every customer is implicitly a Polemarch customer unless
            // explicitly opted out via `custom_is_mithtech_only` (which
            // also gates the Frappe Webhook condition + canonical
            // mapping pull_filter, so in practice we never see
            // mithtech-only rows here at all — `is_polemarch_customer`
            // collapses to `true` for every row we receive). Keep the
            // derivation defensive in case Frappe's payload starts
            // including mithtech-only rows during a future schema drift.
            is_polemarch_customer: !Boolean(
                Number(data?.custom_is_mithtech_only ?? 0),
            ),
            frappe_customer_name: data?.name ?? null,
            // Stamp the event_id so a retry sees the same input was
            // processed and is a no-op at the diff level.
            erpnext_synced_event_id: event_id,
        }
        let customer_id: string
        let created = false
        if (!customer) {
            // Customer doesn't exist on Medusa side yet — could be a
            // back-fill scenario. Create a barebones row.
            const [c] = await customerModule.createCustomers([
                {
                    email,
                    first_name: data?.customer_name ?? "",
                    phone: data?.mobile_no ?? null,
                    metadata: meta,
                },
            ])
            customer_id = c.id
            created = true
        } else {
            await customerModule.updateCustomers(customer.id, {
                phone: data?.mobile_no ?? customer.phone,
                metadata: { ...(customer.metadata ?? {}), ...meta },
            })
            customer_id = customer.id
        }

        // Phase B (Frappe → Medusa) — bank + demat child-row sync.
        // The Frappe Customer Webhook (frappe-webhooks.ts) embeds the
        // `custom_bank_details` and `custom_dp_details` child tables in
        // the payload. We forward both arrays through the cashfree_
        // wallet module: existing rows are display-field-updated, new
        // demat rows are created (with manual_override=true so the
        // verification audit trail records the Frappe operator's
        // decision). New BANK rows are NOT auto-created — the Medusa
        // bank flow requires the full account number + Cashfree penny-
        // drop to compute bank_hash + encrypt the account column, so
        // operator-added banks on the Frappe side land as a
        // `manual_review_pending` log entry that an admin can use to
        // bootstrap the customer's Medusa side via the storefront.
        //
        // Loop prevention: each upsert is no-op when the data matches
        // what's already on Medusa, so the resulting bank/demat row
        // update doesn't fire a Medusa event and the push back to
        // Frappe stays idle.
        let bankSync: any = null
        let dematSync: any = null
        try {
            bankSync = await this._syncBankAccountsFromFrappe(
                scope,
                customer_id,
                Array.isArray(data?.bank_accounts) ? data.bank_accounts : [],
            )
        } catch (err) {
            bankSync = { error: (err as Error)?.message ?? String(err) }
        }
        try {
            dematSync = await this._syncDematAccountsFromFrappe(
                scope,
                customer_id,
                Array.isArray(data?.demat_accounts) ? data.demat_accounts : [],
            )
        } catch (err) {
            dematSync = { error: (err as Error)?.message ?? String(err) }
        }

        return created
            ? { created: true, customer_id, banks: bankSync, demats: dematSync }
            : { updated: true, customer_id, banks: bankSync, demats: dematSync }
    }

    /**
     * Phase B — bank-account reverse-sync from Frappe payload.
     *
     * For each incoming row:
     *   - Match Medusa BankAccount by (customer_id, ifsc, account_
     *     number_last4). The Frappe-side child stores `ac_number`
     *     which is the Medusa-pushed last4 for Medusa-originated
     *     rows; for operator-added rows it may be the full number,
     *     so we take the trailing 4 chars to be safe.
     *   - If matched: only update display fields (bank_name,
     *     account_holder_name, is_primary). Skip the write entirely
     *     when nothing differs — that's what stops the bounce-back
     *     loop. Verification status is NEVER overwritten from this
     *     path because Cashfree/admin owns that decision.
     *   - If unmatched: NO create. The Medusa BankAccount entity
     *     requires the full encrypted account_number to compute the
     *     bank_hash used for dedupe and registry lookup, and the
     *     storefront/admin flow is the only path that knows how to
     *     handle that securely. Unmatched rows are reported in the
     *     result so the admin can investigate.
     */
    private async _syncBankAccountsFromFrappe(
        scope: any,
        customer_id: string,
        rows: any[],
    ): Promise<any> {
        if (!Array.isArray(rows) || rows.length === 0) {
            return { updated: 0, unmatched: 0, no_op: 0, skipped: 0 }
        }
        const wallet = scope.resolve("cashfree_wallet")
        const existing = ((await wallet.listBankAccounts(
            { customer_id } as any,
            { take: 100 } as any,
        )) ?? []) as any[]
        let updated = 0
        let unmatched = 0
        let no_op = 0
        let skipped = 0
        for (const row of rows) {
            const ifsc = String(row?.bank_code ?? "").toUpperCase()
            const acNum = String(row?.ac_number ?? "")
            const last4 = acNum.slice(-4)
            if (!ifsc || !last4) {
                skipped++
                continue
            }
            const match = existing.find(
                (b) =>
                    String(b.ifsc ?? "").toUpperCase() === ifsc &&
                    String(b.account_number_last4 ?? "") === last4,
            )
            if (!match) {
                unmatched++
                continue
            }
            const bankName = String(row?.bank_name ?? "") || match.bank_name
            const holder =
                String(row?.account_holder ?? "") || match.account_holder_name
            const isPrimary = Boolean(Number(row?.is_primary ?? 0))
            const diffs: Record<string, any> = {}
            if (bankName !== match.bank_name) diffs.bank_name = bankName
            if (holder !== match.account_holder_name)
                diffs.account_holder_name = holder
            if (isPrimary !== Boolean(match.is_primary))
                diffs.is_primary = isPrimary
            if (Object.keys(diffs).length === 0) {
                no_op++
                continue
            }
            await wallet.updateBankAccounts({
                selector: { id: match.id },
                data: diffs,
            })
            updated++
        }
        return { updated, unmatched, no_op, skipped }
    }

    /**
     * Phase B — demat-account reverse-sync from Frappe payload.
     *
     * Demat rows are simpler than banks: no encryption, no
     * Cashfree-side hash, and the bo_id (CDSL 16-digit OR NSDL
     * dp_id+client_id) uniquely identifies the row across both
     * systems. So this handler DOES create new demat rows on the
     * Medusa side for operator-added entries — with
     * `verification_status="verified"` and a manual_override flag
     * in verification_raw so the audit trail records the Frappe
     * operator as the source.
     *
     * Loop prevention: same as banks — display-field updates are a
     * no-op when nothing differs.
     */
    private async _syncDematAccountsFromFrappe(
        scope: any,
        customer_id: string,
        rows: any[],
    ): Promise<any> {
        if (!Array.isArray(rows) || rows.length === 0) {
            return { updated: 0, created: 0, no_op: 0, skipped: 0 }
        }
        const wallet = scope.resolve("cashfree_wallet")
        const existing = ((await wallet.listDematAccounts(
            { customer_id } as any,
            { take: 100 } as any,
        )) ?? []) as any[]
        let updated = 0
        let created = 0
        let no_op = 0
        let skipped = 0
        for (const row of rows) {
            const depository = String(row?.depository ?? "").toUpperCase()
            const dpId = String(row?.dp_id ?? "")
            const clientId = String(row?.client_id ?? "")
            // Reconstruct bo_id the same way the Frappe-side helper
            // does (sync_demat_accounts in medusa_webhook.py): CDSL
            // is the raw 16-digit number; NSDL is dp_id+client_id.
            let bo_id = String(row?.bo_id ?? "")
            if (!bo_id) {
                bo_id = depository === "CDSL" ? "" : `${dpId}${clientId}`
            }
            if (!bo_id) {
                skipped++
                continue
            }
            // Match priority: bo_id (Medusa field: `boid`), then
            // (dp_id, client_id) pair.
            const match = existing.find((d) => {
                if (depository === "CDSL") {
                    return String(d.boid ?? "") === bo_id
                }
                return (
                    String(d.dp_id ?? "") === dpId &&
                    String(d.client_id ?? "") === clientId
                )
            })
            const dpName = String(row?.dp_name ?? "")
            const holder = String(row?.primary_bo_name ?? "")
            const cmrUrl = String(row?.cmr_copy ?? "")
            const isPrimary = Boolean(Number(row?.is_primary ?? 0))
            if (match) {
                const diffs: Record<string, any> = {}
                if (dpName && dpName !== match.dp_name) diffs.dp_name = dpName
                if (
                    holder &&
                    holder !== (match.account_holder_name ?? "")
                )
                    diffs.account_holder_name = holder
                if (cmrUrl && cmrUrl !== (match.cmr_file_url ?? ""))
                    diffs.cmr_file_url = cmrUrl
                if (isPrimary !== Boolean(match.is_primary))
                    diffs.is_primary = isPrimary
                if (Object.keys(diffs).length === 0) {
                    no_op++
                    continue
                }
                await wallet.updateDematAccounts({
                    selector: { id: match.id },
                    data: diffs,
                })
                updated++
            } else {
                // Create new demat with manual_override flag. Frappe
                // operator is the source of truth — Medusa records
                // verification_status="verified" without a Cashfree
                // CMR call, but logs the override for audit.
                await wallet.createDematAccounts({
                    customer_id,
                    depository: depository || "CDSL",
                    boid: depository === "CDSL" ? bo_id : null,
                    dp_id: dpId || null,
                    client_id: clientId || null,
                    dp_name: dpName,
                    account_holder_name: holder,
                    cmr_file_url: cmrUrl,
                    is_primary: isPrimary,
                    verification_status: "verified",
                    verified_at: new Date(),
                    verification_raw: {
                        manual_override: true,
                        source: "frappe.customer.updated",
                        note: "Created from Frappe-side custom_dp_details child row",
                    },
                })
                created++
            }
        }
        return { updated, created, no_op, skipped }
    }

    private async _handleWalletCredit(
        data: any,
        event_id: string,
        scope: any,
        opts: { kind: string; note: string; amount_override?: number },
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const customer = await this._resolveCustomerForWalletEvent(scope, data)
        if (!customer) {
            return {
                skipped: true,
                reason: "customer_not_found",
                email: data?.customer_email,
                frappe_customer: data?.customer,
            }
        }
        const amountRupees = Number(opts.amount_override ?? data?.amount ?? 0)
        if (!amountRupees || amountRupees <= 0) {
            return { skipped: true, reason: "zero_amount" }
        }
        // Frappe stores currency in INR (rupees) — `amount=100` means
        // ₹100. The Medusa wallet service stores everything in paise
        // and accepts `amount_inr` as paise (misnamed field, see
        // service.ts). Convert here so we don't end up with ₹0.30
        // wallet credits when Frappe books a ₹30 deposit.
        const amountPaise = Math.round(amountRupees * 100)
        const walletModule = scope.resolve("cashfree_wallet")
        const tx = await walletModule.credit({
            customer_id: customer.id,
            amount_inr: amountPaise,
            kind: "vba_credit",
            reference_type: "vba_event",
            reference_id: data?.gateway_ref ?? data?.name ?? event_id,
            cashfree_event_id: event_id,
            idempotency_key: `frappe:${event_id}`,
            metadata: {
                source: opts.kind,
                note: opts.note,
                frappe_name: data?.name,
                frappe_event_id: event_id,
            },
        })
        return { credited: true, tx_id: tx?.id, amount_rupees: amountRupees }
    }

    private async _handleWalletDebit(
        data: any,
        event_id: string,
        scope: any,
        opts: { kind: string; note: string },
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const customer = await this._resolveCustomerForWalletEvent(scope, data)
        if (!customer) {
            return {
                skipped: true,
                reason: "customer_not_found",
                email: data?.customer_email,
                frappe_customer: data?.customer,
            }
        }
        const amountRupees = Number(data?.amount ?? 0)
        if (!amountRupees || amountRupees <= 0) {
            return { skipped: true, reason: "zero_amount" }
        }
        // Rupees→paise (see _handleWalletCredit comment).
        const amountPaise = Math.round(Math.abs(amountRupees) * 100)
        const walletModule = scope.resolve("cashfree_wallet")
        // Use the dedicated debit() method (positive amount; kind=
        // manual_adjust). The earlier attempt to pass a negative
        // amount to credit() failed because credit() rejects
        // non-positive amounts.
        const tx = await walletModule.debit({
            customer_id: customer.id,
            amount_inr: amountPaise,
            kind: "manual_adjust",
            reference_type: "manual",
            reference_id: data?.name ?? event_id,
            idempotency_key: `frappe:${event_id}`,
            note: opts.note,
            metadata: {
                source: opts.kind,
                frappe_name: data?.name,
                frappe_event_id: event_id,
            },
        })
        return { debited: true, tx_id: tx?.transaction_id, amount_rupees: amountRupees }
    }

    private async _handleWalletReverse(
        data: any,
        event_id: string,
        scope: any,
        opts: { event: string },
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const walletModule = scope.resolve("cashfree_wallet")
        // The original tx was created with idempotency_key=frappe:
        // <original-event-id>. The cancel event_id is the original
        // event_id + ":cancel" (see frappe-webhooks.ts blueprints).
        // Trim the suffix to find the source row.
        const originalEventId = String(event_id).replace(/:cancel$/, "")
        // walletModule exposes reverseDebit(original_transaction_id)
        // but we don't have the tx_id here — only the idempotency
        // key. Use the standard reverse-by-reference helper if it
        // exists; otherwise fall back to a no-op + log.
        if (typeof walletModule.reverseByIdempotencyKey === "function") {
            const result = await walletModule.reverseByIdempotencyKey(
                `frappe:${originalEventId}`,
                opts.event,
            )
            return { reversed: true, ...result }
        }
        return {
            skipped: true,
            reason: "no_reverse_helper",
            todo: "Add cashfree_wallet.reverseByIdempotencyKey(key, reason) or store the tx_id on the original sync_event row to enable reversal",
            original_event_id: originalEventId,
        }
    }

    /**
     * Backend / Direct order from Frappe → create a Medusa Order.
     *
     * Skip if `medusa_order_id` is already set — that's a storefront
     * order that originated in Medusa and round-tripped through
     * Frappe (shouldn't reach us because the Frappe Webhook's
     * source filter excludes Platform Purchase, but defense in
     * depth).
     *
     * Idempotency: subsequent calls with the same event_id hit the
     * existing erpnext_sync_event row and short-circuit before
     * reaching here. If somehow they don't, we still skip when the
     * order already exists by metadata.frappe_name.
     */
    private async _handleOrderPlaced(
        data: any,
        event_id: string,
        scope: any,
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        if (data?.medusa_order_id) {
            return {
                skipped: true,
                reason: "already_medusa_order",
                medusa_order_id: data.medusa_order_id,
            }
        }
        // Resolve customer — Frappe gives us the Customer DocName in
        // data.customer (e.g. "CUST-2024-00001"), not the email. Look
        // it up on the Frappe side via a join in the webhook payload
        // is a future enhancement; for now we try to match by
        // customer_email if the Frappe Webhook body includes it
        // (Security Sale templates may not — falling back to a skip
        // with a clear reason).
        const email = String(data?.customer_email ?? "").toLowerCase()
        if (!email) {
            return {
                skipped: true,
                reason: "no_customer_email_in_payload",
                hint: "Update SecuritySale__on_submit webhook template to include customer_email (lookup via doc.customer → Customer.email_id)",
            }
        }
        const customer = await this._resolveCustomerByEmail(scope, email)
        if (!customer) {
            return { skipped: true, reason: "customer_not_found", email }
        }
        // Resolve product by ISIN (handle = lowercased ISIN per the
        // canonical mapping).
        const productModule = scope.resolve("product")
        const isin = String(data?.security ?? "").trim()
        if (!isin) return { skipped: true, reason: "missing_security_isin" }
        const products = await productModule.listProducts(
            { handle: isin.toLowerCase() },
            { take: 1, relations: ["variants"] },
        )
        const product = products?.[0]
        const variantId = product?.variants?.[0]?.id
        if (!variantId) {
            return {
                skipped: true,
                reason: "no_variant_for_isin",
                isin,
                hint: "Run the Security pull cron or fire a security.updated webhook first so the Product exists",
            }
        }
        // Dedupe — if an order already exists for this frappe_name, skip.
        const orderModule = scope.resolve("order")
        const existingOrders = await orderModule
            .listOrders(
                { metadata: { frappe_name: data?.name } as any },
                { take: 1 },
            )
            .catch(() => [])
        if (existingOrders?.length) {
            return {
                skipped: true,
                reason: "order_already_exists",
                order_id: existingOrders[0].id,
            }
        }
        const qty = Number(data?.qty ?? 0)
        const rate = Number(data?.rate ?? 0)
        if (qty <= 0 || rate <= 0) {
            return { skipped: true, reason: "zero_qty_or_rate" }
        }
        const [order] = await orderModule.createOrders([
            {
                customer_id: customer.id,
                email: customer.email,
                currency_code: "inr",
                metadata: {
                    source: data?.source || "Backend Order",
                    frappe_name: data?.name,
                    frappe_posting_date: data?.posting_date,
                    erpnext_synced_event_id: event_id,
                },
            },
        ])
        // Line items are a separate call in Medusa v2.
        await orderModule.createOrderLineItems(order.id, [
            {
                title: product.title,
                quantity: qty,
                unit_price: rate,
                variant_id: variantId,
                product_id: product.id,
                metadata: {
                    isin,
                    frappe_security: data?.security,
                },
            },
        ])
        return { created: true, order_id: order.id, variant_id: variantId }
    }

    /**
     * Backend / Direct order cancellation from Frappe → cancel the
     * Medusa Order. Lookup priority: medusa_order_id → metadata.
     * frappe_name. Already-canceled orders short-circuit.
     */
    private async _handleOrderCanceled(
        data: any,
        event_id: string,
        scope: any,
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const orderModule = scope.resolve("order")
        let order: any = null
        if (data?.medusa_order_id) {
            order = await orderModule
                .retrieveOrder(data.medusa_order_id)
                .catch(() => null)
        }
        if (!order && data?.name) {
            const matches = await orderModule
                .listOrders(
                    { metadata: { frappe_name: data.name } as any },
                    { take: 1 },
                )
                .catch(() => [])
            order = matches?.[0] ?? null
        }
        if (!order) {
            return { skipped: true, reason: "order_not_found" }
        }
        if (order.canceled_at) {
            return {
                skipped: true,
                reason: "already_canceled",
                order_id: order.id,
            }
        }
        await orderModule.cancel(order.id)
        return { canceled: true, order_id: order.id }
    }

    private async _handleSecurityUpserted(
        data: any,
        event_id: string,
        scope: any,
    ): Promise<any> {
        if (!scope) return { skipped: true, reason: "no_scope" }
        const isin = String(data?.isin ?? "").trim()
        if (!isin) return { skipped: true, reason: "missing_isin" }
        const productModule = scope.resolve("product")
        const handle = isin.toLowerCase()
        // Existence check keyed on metadata.isin FIRST (the natural
        // key). A canonical product may already exist under a human
        // handle (e.g. "api-holdings") carrying this ISIN — matching
        // ONLY by the lowercased-ISIN handle misses it and creates a
        // priceless duplicate stub (no variant / no INR price /
        // no pricing_mode). Fall back to the handle lookup so legacy
        // stubs from earlier versions of this handler still update.
        const byIsin = await productModule.listProducts(
            { metadata: { isin } },
            { select: ["id", "handle", "metadata"], take: 1 },
        )
        let existing = byIsin?.[0]
        if (!existing) {
            const byHandle = await productModule.listProducts(
                { handle },
                { select: ["id", "handle", "metadata"], take: 1 },
            )
            existing = byHandle?.[0]
        }
        const metadata = {
            isin,
            security_type: data?.security_type ?? null,
            face_value: Number(data?.face_value ?? 0),
            last_traded_price: Number(data?.last_traded_price ?? 0),
            company_name: data?.company_name ?? null,
            sector: data?.sector ?? null,
            rta: data?.rta ?? null,
            polemarch_page_url: data?.polemarch_page_url ?? null,
            calcula_page_url: data?.calcula_page_url ?? null,
            tradable: Number(data?.tradable ?? 0) === 1,
            active: Number(data?.active ?? 0) === 1,
            frappe_name: data?.name,
            erpnext_synced_event_id: event_id,
        }
        const status =
            Number(data?.active ?? 0) && Number(data?.tradable ?? 0)
                ? "published"
                : "draft"
        const title = data?.security_name || `Security ${isin}`
        if (existing) {
            // MERGE metadata rather than replace — updateProducts
            // overwrites the whole metadata blob, so a bare patch would
            // wipe Medusa-native keys (pricing_mode, search_aliases,
            // canary flags, calcula-derived price fields, …). Leave
            // `handle` untouched so a canonical product keeps its
            // storefront URL instead of being renamed to the ISIN.
            await productModule.updateProducts(existing.id, {
                title,
                status,
                metadata: { ...(existing.metadata || {}), ...metadata },
            })
            // If the existing product has no variants (e.g. created by
            // an earlier handler version that didn't include them),
            // attach a default one so order.placed can find it.
            const variants = await productModule
                .listProductVariants({ product_id: existing.id }, { take: 1 })
                .catch(() => [])
            if (!variants?.length) {
                await productModule.createProductVariants([
                    {
                        product_id: existing.id,
                        title: "Default",
                        sku: isin,
                        manage_inventory: false,
                    },
                ])
            }
            return { updated: true, product_id: existing.id }
        }
        const [created] = await productModule.createProducts([
            {
                handle,
                title,
                status,
                metadata,
                // Embed a default variant so order.placed can resolve
                // a variant_id immediately after the product lands.
                variants: [
                    {
                        title: "Default",
                        sku: isin,
                        manage_inventory: false,
                    },
                ],
            } as any,
        ])
        return { created: true, product_id: created?.id }
    }

    private async upsertInboundEventRow(
        args: { event: string; event_id: string; data: any },
        patch: {
            status: string
            last_error: string | null
            origin?: string | null
            correlation_id?: string | null
            entity_ref?: string | null
            site_id?: string | null
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
     * Re-attempt a previously failed (or skipped) event. Replays the
     * stored payload — see route doc for why we don't re-fetch.
     */
    async retryEvent(eventId: string, scope?: any): Promise<ForwardResult> {
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
        // Defect B: an inbound row must be RE-APPLIED via the inbound
        // dispatcher — never pushed back outbound (which is what forwardEvent
        // does). Needs a request/cron scope to resolve the target modules.
        if (row.direction === "inbound") {
            if (!scope) {
                return {
                    ok: false,
                    status: "failed",
                    error: "inbound event retry needs a request scope",
                }
            }
            try {
                const result = await this.dispatchInbound(
                    row.event,
                    row.payload,
                    row.event_id,
                    scope,
                )
                void result
                return { ok: true, status: "success" }
            } catch (err: any) {
                return {
                    ok: false,
                    status: "failed",
                    error: describeError(err),
                }
            }
        }
        // Defect A: an outbound row created by a MAPPING must replay through
        // that same mapping (field transform + Sales-Order augmentation), not
        // the legacy full-payload forwardEvent path (wrong Frappe method, no
        // transform) — which would silently write the wrong shape.
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
                })
            }
        }
        return this.forwardEvent({
            event: row.event,
            event_id: row.event_id,
            data: row.payload,
        })
    }

    /**
     * List the most recent failed/skipped events, oldest-attempt first
     * — the order a retry job would process them in.
     */
    async listFailedForRetry(limit = 50) {
        return this.listErpnextSyncEvents(
            { status: ["failed", "skipped"] as any },
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
            /** Provenance: who caused this row, and the chain it belongs
             *  to. See the wire contract in ./envelope.ts. */
            origin?: string | null
            correlation_id?: string | null
            entity_ref?: string | null
            site_id?: string | null
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

    // ─────────────────────────────────────────────────────────────────
    // Settings surface
    // ─────────────────────────────────────────────────────────────────

    /**
     * Returns the row's current values + a masked secret preview, OR
     * defaults if no row exists yet (admin UI shows a fresh form).
     * Never returns the raw secret — callers that need the secret
     * should use `getActiveConfig`.
     */
    async getSettingsView() {
        const row = await this.findSettingsRow()
        if (!row) {
            return {
                exists: false,
                enable_sync: true,
                erpnext_url: null,
                frappe_receive_method:
                    process.env.ERPNEXT_RECEIVE_METHOD ||
                    DEFAULT_RECEIVE_METHOD,
                webhook_secret_masked: maskSecret(
                    process.env.ERPNEXT_WEBHOOK_SECRET,
                ),
                // F0 — Frappe→Medusa secret (separate rotation).
                frappe_to_medusa_secret_masked: null,
                erpnext_api_key_masked: null,
                erpnext_api_secret_masked: null,
                site_id: process.env.ERPNEXT_SITE_ID || DEFAULT_SITE_ID,
                request_timeout_ms: DEFAULT_TIMEOUT_MS,
                auto_retry_failed: true,
                auto_retry_max_attempts: 5,
                auto_retry_min_interval_minutes: 15,
                last_full_resync_at: null,
                push_allowlist: null,
                log_retention_days: 180,
                notes: null,
                updated_by_user_id: null,
                env_fallback: {
                    erpnext_url: process.env.ERPNEXT_URL ?? null,
                    webhook_secret_present: Boolean(
                        process.env.ERPNEXT_WEBHOOK_SECRET,
                    ),
                },
            }
        }
        return {
            exists: true,
            enable_sync: row.enable_sync,
            site_id: row.site_id || process.env.ERPNEXT_SITE_ID || DEFAULT_SITE_ID,
            erpnext_url: row.erpnext_url,
            frappe_receive_method:
                row.frappe_receive_method ||
                process.env.ERPNEXT_RECEIVE_METHOD ||
                DEFAULT_RECEIVE_METHOD,
            webhook_secret_masked: maskSecret(row.webhook_secret),
            frappe_to_medusa_secret_masked: maskSecret(
                row.frappe_to_medusa_secret,
            ),
            erpnext_api_key_masked: maskSecret(row.erpnext_api_key),
            erpnext_api_secret_masked: maskSecret(row.erpnext_api_secret),
            request_timeout_ms: row.request_timeout_ms,
            auto_retry_failed: row.auto_retry_failed,
            auto_retry_max_attempts: row.auto_retry_max_attempts,
            auto_retry_min_interval_minutes: row.auto_retry_min_interval_minutes,
            last_full_resync_at: row.last_full_resync_at,
            // Not a secret — the operator must be able to read and edit
            // the list, so it is returned in full rather than masked.
            push_allowlist: row.push_allowlist ?? null,
            log_retention_days: row.log_retention_days ?? 180,
            notes: row.notes,
            updated_by_user_id: row.updated_by_user_id,
            env_fallback: {
                erpnext_url: process.env.ERPNEXT_URL ?? null,
                webhook_secret_present: Boolean(
                    process.env.ERPNEXT_WEBHOOK_SECRET,
                ),
            },
        }
    }

    /**
     * Persist the settings row.
     *
     * Secret-field semantics (matches cashfree-settings):
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
        if ("site_id" in input) {
            // Lower-cased and trimmed to match the ERPNext side's own rule
            // for a Site ID, so the two never disagree over letter case.
            const raw = (input.site_id ?? "").trim().toLowerCase()
            patch.site_id = raw || null
        }
        if ("erpnext_url" in input) {
            patch.erpnext_url = normaliseUrl(input.erpnext_url)
        }
        if ("frappe_receive_method" in input) {
            const raw = (input.frappe_receive_method ?? "").trim()
            patch.frappe_receive_method = raw || null
        }
        applySecret(patch, "webhook_secret", input.webhook_secret)
        // F0 — Frappe→Medusa secret. Same semantics as the others:
        // undefined/empty = leave as-is, null = clear, string = set.
        applySecret(
            patch,
            "frappe_to_medusa_secret",
            input.frappe_to_medusa_secret,
        )
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
     * Returns the *effective* config used by the forwarder — DB row
     * values fall back to env vars per-field. Never returns secrets
     * to callers it shouldn't, since this is private to the module.
     */
    async getActiveConfig(): Promise<ActiveConfig> {
        const row = await this.findSettingsRow()

        const erpnext_url =
            (row?.erpnext_url || process.env.ERPNEXT_URL || "").replace(
                /\/$/,
                "",
            ) || null
        const webhook_secret =
            row?.webhook_secret || process.env.ERPNEXT_WEBHOOK_SECRET || null

        const url_source: ActiveConfig["source"]["url"] = row?.erpnext_url
            ? "row"
            : process.env.ERPNEXT_URL
                ? "env"
                : "missing"
        const secret_source: ActiveConfig["source"]["secret"] = row
            ?.webhook_secret
            ? "row"
            : process.env.ERPNEXT_WEBHOOK_SECRET
                ? "env"
                : "missing"

        return {
            enable_sync: row?.enable_sync ?? true,
            site_id: row?.site_id || process.env.ERPNEXT_SITE_ID || DEFAULT_SITE_ID,
            erpnext_url,
            webhook_secret,
            frappe_receive_method:
                row?.frappe_receive_method ||
                process.env.ERPNEXT_RECEIVE_METHOD ||
                DEFAULT_RECEIVE_METHOD,
            request_timeout_ms: row?.request_timeout_ms ?? DEFAULT_TIMEOUT_MS,
            auto_retry_failed: row?.auto_retry_failed ?? true,
            auto_retry_max_attempts: row?.auto_retry_max_attempts ?? 5,
            auto_retry_min_interval_minutes:
                row?.auto_retry_min_interval_minutes ?? 15,
            source: { url: url_source, secret: secret_source },
        }
    }

    /**
     * Every site id this instance answers to.
     *
     * Used to recognise our own change coming home: an envelope whose
     * origin is this system at one of these ids, or which is tagged
     * echo_of one of them, is an echo and must not be applied.
     */
    async ourSiteIds(): Promise<string[]> {
        const cfg = await this.getActiveConfig()
        return [cfg.site_id]
    }

    /**
     * Did an inbound write touch this record recently, and if so, who
     * caused it?
     *
     * The breadcrumb is the inbound erpnext_sync_event row itself: it
     * records which Medusa record it wrote and where it came from. An
     * outbound push that finds one is an echo of that write, and says so
     * in its envelope, so the far side drops it rather than applying it
     * and bouncing it back again.
     *
     * Deliberately time-boxed. A person editing the same record an hour
     * later must reach ERPNext normally; only the immediate return trip
     * is suppressed.
     */
    async echoCauseFor(
        entityRef: string | null,
    ): Promise<{ origin: string; correlation_id: string | null } | null> {
        if (!entityRef || entityRef.endsWith(":")) return null
        try {
            const [row] = await this.listErpnextSyncEvents(
                { entity_ref: entityRef, direction: "inbound" as any },
                { take: 1, order: { created_at: "DESC" } as any },
            )
            if (!row?.origin) return null
            // last_attempt_at is when this row was last applied; an inbound
            // row is REUSED across retries, so created_at can be hours old
            // on a write that landed seconds ago.
            const at = (row.last_attempt_at ?? row.created_at) as any
            if (!isWithinEchoWindow(at)) return null
            return { origin: row.origin, correlation_id: row.correlation_id ?? null }
        } catch {
            // A lookup failure must never block a legitimate push; the
            // worst case is one redundant round trip, which the far side
            // dedupes on event_id anyway.
            return null
        }
    }

    // -----------------------------------------------------------------
    // Mapping configuration sync
    //
    // A mapping is one configuration living in two systems. It can be
    // edited from either, so both copies share a mapping_uid and carry a
    // version; the higher version wins, and ERPNext wins a tie because
    // ERPNext owns which documents may sync at all.
    // -----------------------------------------------------------------

    /** Apply a mapping that arrived from ERPNext. Never throws: a refused
     *  mapping is a normal outcome the log records, not a failed request. */
    async applyMappingConfig(canon: CanonicalMapping): Promise<{
        action: "created" | "updated" | "skipped"
        reason?: string
        id?: string
    }> {
        if (!canon?.uid) return { action: "skipped", reason: "missing_uid" }
        const [existing] = await this.listErpnextMappings(
            { mapping_uid: canon.uid },
            { take: 1 },
        )
        const decision = decideConflict(
            existing ? Number(existing.version ?? 1) : null,
            Number(canon.version ?? 1),
        )
        if (!decision.apply) {
            return { action: "skipped", reason: decision.reason, id: existing?.id }
        }
        const patch = fromCanonical(canon)
        if (existing) {
            await this.updateErpnextMappings([
                { id: existing.id, ...patch, last_synced_at: new Date() },
            ])
            return { action: "updated", id: existing.id }
        }
        const [created] = await this.createErpnextMappings([
            {
                ...patch,
                // A mapping we have never seen arrives switched OFF, whatever
                // the sender says. First contact between two systems that each
                // already had mappings would otherwise turn on a rule nobody
                // reviewed here — and a half-translated one at that, since
                // events and any Medusa-only options have no counterpart on
                // the other side. An operator enables it once they have
                // looked. Updates to a uid we already hold apply as sent.
                enabled: false,
                // Which Medusa events fire a push is a Medusa-side concern
                // ERPNext has no opinion on. Empty until an operator says when.
                events: [],
                last_synced_at: new Date(),
            } as any,
        ])
        return { action: "created", id: created?.id, reason: "created_disabled" }
    }

    /** A mapping deleted on the other side is disabled here, not removed:
     *  records already correlated by it must stay traceable. */
    async disableMappingConfig(uid: string): Promise<{ action: string; id?: string }> {
        if (!uid) return { action: "skipped" }
        const [existing] = await this.listErpnextMappings({ mapping_uid: uid }, { take: 1 })
        if (!existing) return { action: "skipped" }
        if (existing.enabled === false) return { action: "skipped", id: existing.id }
        await this.updateErpnextMappings([{ id: existing.id, enabled: false }])
        return { action: "disabled", id: existing.id }
    }

    /** Tell ERPNext about a mapping edited here. */
    async pushMappingConfig(mappingId: string, deleted = false): Promise<ForwardResult> {
        const [row] = await this.listErpnextMappings({ id: mappingId }, { take: 1 })
        if (!row?.mapping_uid) {
            return { ok: true, status: "skipped", reason: "mapping-has-no-uid" }
        }
        const cfg = await this.getActiveConfig()
        if (!cfg.enable_sync || !cfg.erpnext_url || !cfg.webhook_secret) {
            return { ok: true, status: "skipped", reason: "not-configured" }
        }
        const event = deleted ? "mapping.deleted" : "mapping.upserted"
        const event_id = [
            "medusa:mapping",
            row.mapping_uid,
            String(row.version ?? 1),
            event,
        ].join(":")
        const canon = deleted
            ? { uid: row.mapping_uid, version: Number(row.version ?? 1) }
            : toCanonical(row as any)
        const body = JSON.stringify(
            envelope.build({
                event,
                event_id,
                site_id: cfg.site_id,
                kind: envelope.KIND_MAPPING,
                mapping: canon as any,
            }),
        )
        const targetUrl = receiveUrl(cfg)
        const signature = crypto
            .createHmac("sha256", cfg.webhook_secret)
            .update(body)
            .digest("hex")
        const eventRow = await this.upsertEventRow(
            { event, event_id, data: canon },
            { status: "pending", last_error: null, target_url: targetUrl, site_id: cfg.site_id },
        )
        try {
            const res = await fetch(targetUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-medusa-signature": signature,
                    "x-medusa-event-id": event_id,
                },
                body,
                signal: AbortSignal.timeout(cfg.request_timeout_ms),
            })
            if (!res.ok) {
                const text = await res.text().catch(() => "")
                const errMsg = (res.status + ": " + text).slice(0, ERROR_TRUNCATE)
                await this.updateErpnextSyncEvents({
                    id: eventRow.id,
                    status: "failed",
                    last_error: errMsg,
                })
                return { ok: false, status: "failed", httpStatus: res.status, error: errMsg }
            }
            await this.updateErpnextSyncEvents({
                id: eventRow.id,
                status: "success",
                succeeded_at: new Date(),
            })
            await this.updateErpnextMappings([{ id: row.id, last_synced_at: new Date() }])
            return { ok: true, status: "success" }
        } catch (err: any) {
            const errMsg = describeError(err).slice(0, ERROR_TRUNCATE)
            await this.updateErpnextSyncEvents({
                id: eventRow.id,
                status: "failed",
                last_error: errMsg,
            })
            return { ok: false, status: "failed", error: errMsg }
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
    // ERPNext API client surface (pull / ping)
    //
    // The push side uses the webhook URL + HMAC of webhook_secret. The
    // pull / introspection side uses Frappe's standard token-auth
    // (Authorization: token <api_key>:<api_secret>). The two paths are
    // independent — a deployment can have push working without API keys
    // configured, or vice-versa.
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
     * Bulk push helper — fan out a list of resource ids through
     * `forwardEvent`, one event per id. Used by the admin "Push all
     * customers / orders / products" buttons. Returns per-id outcomes
     * so the UI can flag any that failed.
     *
     * The caller is responsible for fetching the enriched payload for
     * each id (we don't reach into the customer / order / product
     * modules from here — keeps this module's deps minimal).
     */
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
    // Field-mapping mirror — read/write the Frappe-side `Polemarch Sync
    // Mapping` Single doctype from the Medusa admin. Frappe stays the
    // canonical store; this is a pull-through view.
    // ─────────────────────────────────────────────────────────────────

    /**
     * Fetch the `Polemarch Sync Mapping` Single doc from Frappe,
     * including all six child mapping tables. Used by the
     * `/app/erpnext-mappings` admin page to render the n8n-style
     * field mapper without duplicating storage on the Medusa side.
     */
    async getSyncMapping(): Promise<{
        ok: boolean
        url: string | null
        mapping?: any
        httpStatus?: number
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
                url: cfg.erpnext_url,
                message: "erpnext_url / api_key / api_secret not all configured",
            }
        }
        try {
            // Single doctype: name == doctype name. URL-encode both.
            const dt = encodeURIComponent("Polemarch Sync Mapping")
            const res = await fetch(
                `${cfg.erpnext_url}/api/resource/${dt}/${dt}`,
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
            const parsed = JSON.parse(text)
            // Frappe wraps single-doc responses under `data`.
            return {
                ok: true,
                url: cfg.erpnext_url,
                mapping: parsed?.data ?? parsed,
            }
        } catch (err: any) {
            return {
                ok: false,
                url: cfg.erpnext_url,
                message: describeError(err).slice(0, 300),
            }
        }
    }

    /**
     * Save edits to the `Polemarch Sync Mapping` Single doc back to
     * Frappe. Body must be the full mapping doc with child tables;
     * partial updates are NOT supported because Frappe replaces the
     * whole child table when the parent is saved (no incremental row
     * insert via the resource API).
     *
     * Returns the updated mapping echoed by Frappe so the admin UI
     * can refresh in place.
     */
    async saveSyncMapping(data: any): Promise<{
        ok: boolean
        url: string | null
        mapping?: any
        httpStatus?: number
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
                url: cfg.erpnext_url,
                message: "erpnext_url / api_key / api_secret not all configured",
            }
        }
        try {
            const dt = encodeURIComponent("Polemarch Sync Mapping")
            const res = await fetch(
                `${cfg.erpnext_url}/api/resource/${dt}/${dt}`,
                {
                    method: "PUT",
                    headers: {
                        Authorization: `token ${apiKey}:${apiSecret}`,
                        "Content-Type": "application/json",
                        // Frappe rejects PUT on resource without
                        // X-Frappe-CSRF-Token unless the request is
                        // token-auth-only (no session cookie). Our
                        // call carries no session cookie so we're
                        // safe — but if Frappe ever tightens, fall
                        // back to frappe.client.set_value here.
                    },
                    body: JSON.stringify(data),
                    signal: AbortSignal.timeout(cfg.request_timeout_ms),
                },
            )
            const text = await res.text().catch(() => "")
            if (!res.ok) {
                return {
                    ok: false,
                    url: cfg.erpnext_url,
                    httpStatus: res.status,
                    message: text.slice(0, 500) || `HTTP ${res.status}`,
                }
            }
            const parsed = JSON.parse(text)
            return {
                ok: true,
                url: cfg.erpnext_url,
                mapping: parsed?.data ?? parsed,
            }
        } catch (err: any) {
            return {
                ok: false,
                url: cfg.erpnext_url,
                message: describeError(err).slice(0, 300),
            }
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
    }) {
        const validated = validateFieldMappings(input.field_mappings ?? [])

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
        }
        if (input.id) {
            const [current] = await this.listErpnextMappings({ id: input.id }, { take: 1 })
            // The same mapping exists on the ERPNext side. Bumping the
            // version here is what lets the two copies be ordered rather
            // than silently overwriting each other; the uid pairs them.
            const [updated] = await this.updateErpnextMappings([
                {
                    id: input.id,
                    ...patch,
                    mapping_uid: current?.mapping_uid || envelope.newCorrelationId(),
                    version: Number(current?.version ?? 1) + 1,
                },
            ])
            await this.announceMappingChange(updated?.id)
            return updated
        }
        const [created] = await this.createErpnextMappings([
            { ...patch, mapping_uid: envelope.newCorrelationId(), version: 1 },
        ])
        await this.announceMappingChange(created?.id)
        return created
    }

    /**
     * Tell ERPNext a mapping changed here.
     *
     * Deliberately swallowing failures: the operator's save has already
     * succeeded, and an ERPNext outage must not make the form look
     * broken. The mapping carries a version, so the next successful
     * exchange in either direction reconciles the two copies anyway.
     */
    private async announceMappingChange(mappingId?: string, deleted = false): Promise<void> {
        if (!mappingId) return
        try {
            await this.pushMappingConfig(mappingId, deleted)
        } catch (err) {
            console.warn("[erpnext] mapping change not announced:", describeError(err))
        }
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
        // Announce first: the push reads the row to learn its uid, and a
        // deleted mapping on one side disables rather than destroys on the
        // other, so records already correlated by it stay traceable.
        await this.announceMappingChange(id, true)
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
        const existing = await this.listErpnextMappings(
            { name: CANONICAL_MAPPINGS.map((m) => m.name) },
            { take: 1000 },
        )
        const existingByName = new Map<string, any>(
            existing.map((r: any) => [r.name, r]),
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
                const existingRow = existingByName.get(m.name)
                await this.saveMapping({
                    id: existingRow?.id,
                    name: m.name,
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
     * F2 — seed Frappe `Webhook` rows on the connected Frappe site.
     *
     * Reads `FRAPPE_WEBHOOK_BLUEPRINTS` and POSTs each one to Frappe's
     * `/api/resource/Webhook`. Idempotent — lookup by name first, skip
     * if present.
     *
     * Resolves the request_url from `erpnext_setting.medusa_base_url`
     * (NEW — set by the operator to whichever Medusa host the Frappe
     * side should call back; e.g. `https://medusa.example.com`).
     * If that's empty, falls back to env var MEDUSA_BASE_URL.
     *
     * Webhook rows are signed with `frappe_to_medusa_secret` so the
     * F1 receiver can HMAC-verify on the other end.
     *
     * Called by:
     *   - POST /admin/erpnext/seed-frappe-webhooks (admin button F4)
     *   - Plugin migration hook on install (one-shot at first deploy)
     */
    async seedFrappeWebhooks(opts?: {
        medusaBaseUrl?: string
    }): Promise<{
        seeded: string[]
        updated: string[]
        skipped: string[]
        errors: { name: string; message: string }[]
    }> {
        const { FRAPPE_WEBHOOK_BLUEPRINTS } = await import(
            "./frappe-webhooks.js"
        )
        const cfg = await this.getActiveConfig()
        const row = await this.findSettingsRow()
        const apiKey = row?.erpnext_api_key ?? process.env.ERPNEXT_API_KEY
        const apiSecret =
            row?.erpnext_api_secret ?? process.env.ERPNEXT_API_SECRET
        const secret =
            row?.frappe_to_medusa_secret ??
            process.env.ERPNEXT_FRAPPE_TO_MEDUSA_SECRET
        const medusaBase = (
            opts?.medusaBaseUrl ||
            process.env.MEDUSA_BASE_URL ||
            ""
        ).replace(/\/$/, "")
        if (!cfg.erpnext_url || !apiKey || !apiSecret) {
            throw new Error(
                "erpnext_url + api_key + api_secret must be set on the Settings tab before seeding.",
            )
        }
        if (!secret) {
            throw new Error(
                "frappe_to_medusa_secret must be set on the Settings tab. Without it, Frappe's Webhook rows would sign with an empty secret and the receiver will reject every push.",
            )
        }
        if (!medusaBase) {
            throw new Error(
                "medusaBaseUrl (or env MEDUSA_BASE_URL) must be set so the Frappe Webhook rows know where to POST.",
            )
        }
        const headers = {
            "Content-Type": "application/json",
            Authorization: `token ${apiKey}:${apiSecret}`,
        }
        const seeded: string[] = []
        const updated: string[] = []
        const errors: { name: string; message: string }[] = []
        for (const bp of FRAPPE_WEBHOOK_BLUEPRINTS) {
            try {
                const bodyData = {
                    name: bp.name,
                    webhook_doctype: bp.webhook_doctype,
                    webhook_docevent: bp.webhook_docevent,
                    condition: bp.condition || "",
                    request_url: `${medusaBase}${bp.request_path}`,
                    is_dynamic_url: 0,
                    timeout: 15,
                    request_method: "POST",
                    request_structure: "JSON",
                    enable_security: 1,
                    webhook_secret: secret,
                    webhook_json: bp.webhook_json,
                    // Frappe's `request_structure: "JSON"` only validates the
                    // template — it doesn't auto-set Content-Type on the
                    // outgoing POST. Without an explicit header, Python
                    // requests sends `Content-Type: <none>` (or text/plain
                    // for string bodies), which makes Express's JSON body
                    // parser skip parsing — req.body lands as `{}` and the
                    // receiver's HMAC ends up signing the empty fallback
                    // `{}` instead of the actual bytes Frappe sent. Pinning
                    // Content-Type: application/json here fixes both the
                    // body parsing AND HMAC validation in one shot.
                    webhook_headers: [
                        { key: "Content-Type", value: "application/json" },
                    ],
                    enabled: 1,
                }
                // Exists?
                const lookup = await fetch(
                    `${cfg.erpnext_url}/api/resource/Webhook/${encodeURIComponent(bp.name)}`,
                    { method: "GET", headers },
                )
                if (lookup.ok) {
                    // UPSERT: PUT to refresh the row in place so blueprint
                    // edits (template tweaks, secret rotation) actually
                    // propagate. Previously skipped existing rows — that
                    // made "Reseed" useless after the first run.
                    const put = await fetch(
                        `${cfg.erpnext_url}/api/resource/Webhook/${encodeURIComponent(bp.name)}`,
                        {
                            method: "PUT",
                            headers,
                            body: JSON.stringify({ data: bodyData }),
                        },
                    )
                    if (!put.ok) {
                        const text = await put.text().catch(() => "")
                        errors.push({
                            name: bp.name,
                            message: `PUT HTTP ${put.status}: ${text.slice(0, 300)}`,
                        })
                        continue
                    }
                    updated.push(bp.name)
                    continue
                }
                const create = await fetch(
                    `${cfg.erpnext_url}/api/resource/Webhook`,
                    {
                        method: "POST",
                        headers,
                        body: JSON.stringify({ data: bodyData }),
                    },
                )
                if (!create.ok) {
                    const text = await create.text().catch(() => "")
                    errors.push({
                        name: bp.name,
                        message: `POST HTTP ${create.status}: ${text.slice(0, 300)}`,
                    })
                    continue
                }
                seeded.push(bp.name)
            } catch (e: any) {
                errors.push({
                    name: bp.name,
                    message: String(e?.message || e),
                })
            }
        }
        return { seeded, updated, skipped: [], errors }
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
        // and `metadata.isin` on push into the same `isin` field).
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

        const result = buildAutofill({
            doctypeFields: (meta.fields ?? []) as DoctypeFieldMeta[],
            entityPaths: descriptor.paths,
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
    async dryRunPush(args: {
        mapping_id: string
        record_id: string
        container: any
    }): Promise<{
        ok: boolean
        payload?: Record<string, any>
        key_value?: string
        skipped_fields?: string[]
        message?: string
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
        const record = await entity.fetchById(args.container, args.record_id)
        if (!record) {
            return { ok: false, message: `no ${mapping.medusa_entity} with id ${args.record_id}` }
        }
        const result = applyMapping({
            direction: "push",
            fields: mapping.field_mappings as MappingFieldPair[],
            mappingDirection: mapping.direction as MappingDirection,
            source: record,
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
        return {
            ok: true,
            payload: result.payload,
            key_value: keyValue,
            skipped_fields: result.skippedFields,
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // Push via mapping
    //
    // Called by the subscriber. Builds the payload via the engine,
    // POSTs to a generic Frappe receiver, logs into erpnext_sync_event
    // tagged with mapping_id.
    // ─────────────────────────────────────────────────────────────────

    /**
     * Push one enriched Medusa record through a specific mapping. The
     * Frappe-side endpoint is the configured Frappe receive method
     * (e.g. `medusync.api.receive`) which accepts `{doctype, key_field,
     * key_value, payload}` and upserts a doctype record.
     *
     * If the receiver isn't deployed yet, the call falls back to a
     * standard `/api/resource/{doctype}` upsert (PUT when the key
     * matches `name`, POST otherwise). This keeps things working with
     * a vanilla Frappe install while still letting the store's
     * receiver add validation / triggers later.
     */
    async pushViaMapping(args: {
        mapping: any
        event: string
        event_id: string
        record: Record<string, any>
    }): Promise<ForwardResult> {
        const cfg = await this.getActiveConfig()
        if (!cfg.enable_sync) {
            return { ok: true, status: "skipped", reason: "sync-disabled" }
        }
        if (!cfg.erpnext_url || !cfg.webhook_secret) {
            await this.upsertEventRow(
                { event: args.event, event_id: args.event_id, data: args.record },
                {
                    status: "skipped",
                    last_error: "ERPNEXT URL / webhook secret not configured",
                    target_url: null,
                    mapping_id: args.mapping.id,
                },
            )
            return { ok: true, status: "skipped", reason: "not-configured" }
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

        const targetUrl = receiveUrl(cfg, true)
        // Sales documents (Sales Order / Sales Invoice) need a child line-items
        // table + a customer link, which a flat field mapping cannot express.
        // For those doctypes only, enrich the mapped payload with `medusa_items`,
        // `medusa_customer_id` and `contact_email` derived from the order record
        // (minor units → rupees). Every other doctype is untouched, so the plugin
        // stays generic.
        const outPayload = augmentCustomerPayload(
            args.mapping.doctype,
            augmentSalesDocPayload(
                args.mapping.doctype,
                transform.payload,
                args.record,
            ),
            args.record,
        )
        // Was this record just written BY ERPNext? Then what we are about
        // to send is ERPNext's own change coming home; tag it so the far
        // side drops it instead of applying it again and bouncing it back.
        // This is what stops a loop once the round trip has crossed a
        // worker, where no in-request guard survives.
        const cause = await this.echoCauseFor(
            `${args.mapping.medusa_entity}:${args.record?.id ?? ""}`,
        )
        const body = JSON.stringify(
            envelope.build({
                event: args.event,
                event_id: args.event_id,
                site_id: cfg.site_id,
                kind: envelope.KIND_MAPPED,
                mapping_id: args.mapping.id,
                mapping_name: args.mapping.name,
                doctype: args.mapping.doctype,
                key_field: effKeyField,
                key_value: effKeyValue,
                payload: outPayload,
                correlation_id: cause?.correlation_id ?? null,
                echo_of: cause?.origin ?? null,
                // The far side decides create-vs-update from whether the key
                // matches an existing doc; these say what it is ALLOWED to
                // do once it knows. Sent every time so an older receiver
                // that ignores them simply behaves as it always has.
                allow_create: args.mapping.allow_create !== false,
                allow_update: args.mapping.allow_update !== false,
            }),
        )
        const signature = crypto
            .createHmac("sha256", cfg.webhook_secret)
            .update(body)
            .digest("hex")
        const row = await this.upsertEventRow(
            { event: args.event, event_id: args.event_id, data: args.record },
            {
                status: "pending",
                last_error: null,
                target_url: targetUrl,
                mapping_id: args.mapping.id,
            },
        )
        try {
            const res = await fetch(targetUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-medusa-signature": signature,
                    "x-medusa-event-id": args.event_id,
                },
                body,
                signal: AbortSignal.timeout(cfg.request_timeout_ms),
            })
            if (!res.ok) {
                const text = await res.text().catch(() => "")
                const errMsg = `${res.status}: ${text}`.slice(0, ERROR_TRUNCATE)
                await this.updateErpnextSyncEvents({
                    id: row.id,
                    status: "failed",
                    last_error: errMsg,
                })
                await this.markMappingPushOutcome(args.mapping.id, errMsg)
                return { ok: false, status: "failed", httpStatus: res.status, error: errMsg }
            }
            // The receiver reports what it did with the doc; record it
            // so "why is this customer missing in ERPNext" is answerable
            // from the log without re-running anything. Falls back to
            // "synced" against a receiver too old to say.
            let action = "synced"
            try {
                const parsed = JSON.parse(await res.clone().text().catch(() => "{}"))
                action =
                    parsed?.message?.status ??
                    parsed?.message?.action ??
                    parsed?.status ??
                    parsed?.action ??
                    "synced"
            } catch {
                /* non-JSON body — keep the default */
            }
            await this.updateErpnextSyncEvents({
                id: row.id,
                status: "success",
                succeeded_at: new Date(),
                action: String(action).slice(0, 40),
                payload_hash: payloadHash,
            })
            await this.markMappingPushOutcome(args.mapping.id, null)
            return { ok: true, status: "success", action }
        } catch (err: any) {
            const errMsg = describeError(err).slice(0, ERROR_TRUNCATE)
            await this.updateErpnextSyncEvents({
                id: row.id,
                status: "failed",
                last_error: errMsg,
            })
            await this.markMappingPushOutcome(args.mapping.id, errMsg)
            return { ok: false, status: "failed", error: errMsg }
        }
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
        const fields = uniqueFrappeFields(mapping.field_mappings as MappingFieldPair[], mapping.key_erpnext_field)
        const qs = new URLSearchParams()
        qs.set("limit_page_length", String(mapping.pull_page_size ?? 200))
        qs.set("order_by", "modified asc")
        qs.set("fields", JSON.stringify(fields))
        if (filters.length) qs.set("filters", JSON.stringify(filters))
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
                const msg = `HTTP ${res.status}: ${text.slice(0, 300)}`
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
        for (const row of rows) {
            if (row?.modified && (!maxModified || row.modified > maxModified)) {
                maxModified = row.modified
            }
            const transform = applyMapping({
                direction: "pull",
                fields: mapping.field_mappings as MappingFieldPair[],
                mappingDirection: mapping.direction as MappingDirection,
                source: row,
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
            const outcome = await entity.upsertByKey(
                args.container,
                mapping.key_medusa_field,
                keyValue,
                transform.payload,
            )
            if (!outcome.ok) {
                errors += 1
                continue
            }
            if (outcome.created) created += 1
            else updated += 1
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

// ─── Module-level meta cache ─────────────────────────────────────────
// Field-meta lookups are pure on the Frappe side; cache per-process
// for 5 minutes so the admin field-mapper UI feels snappy.
const _META_CACHE_TTL_MS = 5 * 60 * 1000
const _metaCache = new Map<
    string,
    { fields: any[]; expiresAt: number }
>()

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Constant-time string compare. Buffer.from with unequal lengths
 * throws on timingSafeEqual, so length-mismatch short-circuits early
 * (already unsafe in the timing sense but matches the practical
 * threat model — the attacker doesn't gain anything from knowing
 * "your secret isn't 64 chars").
 */
function safeEq(a: string, b: string): boolean {
    if (typeof a !== "string" || typeof b !== "string") return false
    if (a.length !== b.length) return false
    try {
        return crypto.timingSafeEqual(
            Buffer.from(a, "utf8"),
            Buffer.from(b, "utf8"),
        )
    } catch {
        return false
    }
}

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

function normaliseUrl(input?: string | null) {
    if (input === null) return null
    if (input === undefined || input === "") return undefined as any
    return input.replace(/\/$/, "")
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
        if (!medusa_path || !erpnext_field) continue
        const pair: MappingFieldPair = {
            medusa_path,
            erpnext_field,
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
 */
function uniqueFrappeFields(pairs: MappingFieldPair[], keyField: string): string[] {
    const set = new Set<string>(["name", "modified"])
    if (keyField) set.add(keyField)
    for (const p of pairs ?? []) {
        if (p?.erpnext_field) set.add(p.erpnext_field)
    }
    return Array.from(set)
}

export default Module(ERPNEXT_MODULE, {
    service: ErpnextModuleService,
})
