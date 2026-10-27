import crypto from "crypto"
import type { FrappeClient, FrappeResult } from "./frappe-client"
import {
    DIRECTION_BOTH,
    DIRECTION_ERPNEXT_TO_MEDUSA,
    DIRECTION_NONE,
    SELECTION_FIELD,
    SELECTION_OPTIONS,
    selectionDefault,
    type SyncDoctype,
    type SyncMode,
} from "./selection"
import { SALES_INVOICE_DOCTYPE } from "./invoice-events"
import {
    ITEM_PRICE_DOCTYPE,
    SALES_ORDER_DOCTYPE,
    STOCK_LEDGER_DOCTYPE,
    itemPriceCondition,
    stockLedgerCondition,
} from "./stock-prices"
import { walletWebhookSpecs } from "./wallet-sync"

/**
 * "Set up ERPNext": everything this plugin needs on the ERPNext side,
 * created over REST so nobody clicks through Desk.
 *
 * Per selection DocType, in this order:
 *   1. Custom Field `<DocType>-medusa_sync` (Select, "Sync to Medusa":
 *      blank / ERPNext → Medusa / Medusa → ERPNext / Both). First,
 *      because a Webhook's condition is validated against a blank
 *      document when the Webhook is saved.
 *   2. Webhook `Medusa Sync: <DocType> on_update` — fires when the
 *      document moves ERPNext → Medusa, or did before this save (so a
 *      deselection arrives once and drafts the product). `on_update` also
 *      runs on insert, so no `after_insert` hook is needed.
 *   3. Webhook `Medusa Sync: <DocType> on_trash` — fires for a document
 *      moving ERPNext → Medusa being deleted.
 *
 * Both Webhooks POST the whole document as JSON, signed with the shared
 * secret, plus the `Content-Type: application/json` header Frappe does not
 * send by itself and Medusa needs in order to keep the raw body.
 *
 * Re-running is safe: a row that already says the right thing is left
 * alone, one that drifted is updated, and the set-once fields
 * (`webhook_doctype`, `webhook_docevent`) are never sent to an existing
 * row. Frappe masks `webhook_secret` on read, so whether the secret is
 * current is decided by a fingerprint kept in the last report.
 *
 * Every builder here is pure; the `ensure*` functions take a client.
 */

export const INBOUND_PATH = "/webhooks/erpnext-inbound"

export type WebhookEvent = "on_update" | "on_trash" | "after_insert" | "on_submit" | "on_cancel"
/** The two a selection DocType gets. */
export const WEBHOOK_EVENTS: WebhookEvent[] = ["on_update", "on_trash"]

export const CUSTOM_FIELD_LABEL = "Sync to Medusa"

/** The Python tuple of values under which ERPNext → Medusa applies. */
const PULL_TUPLE = `("${DIRECTION_ERPNEXT_TO_MEDUSA}", "${DIRECTION_BOTH}")`

/** Fires for a document that moves ERPNext → Medusa now or did before
 *  this save, and for any change of the field (so a document that stops
 *  being Medusa-owned is noticed). `get_doc_before_save()` is None on
 *  insert and on the blank document Frappe validates the condition
 *  against; `and` short-circuits. */
export const ON_UPDATE_CONDITION =
    `doc.get("medusa_sync") in ${PULL_TUPLE} or (doc.get_doc_before_save() and (doc.get_doc_before_save().get("medusa_sync") in ${PULL_TUPLE} or doc.get("medusa_sync") != doc.get_doc_before_save().get("medusa_sync")))`

export const ON_TRASH_CONDITION = `doc.get("medusa_sync") in ${PULL_TUPLE}`

/** Frappe's Select options, one per line. No blank line: "not set" is the
 *  explicit None, and Frappe skips validating an empty value, so documents
 *  left blank before None existed still save. */
export const SELECT_OPTIONS = SELECTION_OPTIONS.join("\n")

/** Frappe renders this with Jinja, `doc` being `as_dict()` and `json`
 *  being `frappe.as_json`, then `json.loads` the result. */
export function webhookJsonTemplate(event: WebhookEvent): string {
    return `{"event":${JSON.stringify(event)},"doctype":{{ doc.doctype | json }},"name":{{ doc.name | json }},"doc":{{ doc | json }}}`
}

export function customFieldName(doctype: string): string {
    return `${doctype}-${SELECTION_FIELD}`
}

export function webhookName(doctype: string, event: WebhookEvent): string {
    return `Medusa Sync: ${doctype} ${event}`
}

export function inboundUrl(publicUrl: string): string {
    return `${String(publicUrl ?? "").trim().replace(/\/+$/, "")}${INBOUND_PATH}`
}

export function buildCustomField(doctype: string, mode: SyncMode): Record<string, any> {
    return {
        doctype: "Custom Field",
        dt: doctype,
        fieldname: SELECTION_FIELD,
        label: CUSTOM_FIELD_LABEL,
        fieldtype: "Select",
        options: SELECT_OPTIONS,
        default: selectionDefault(mode),
        // Item keeps it next to "Disabled" where a person looks for such
        // switches; any other DocType gets it at the end.
        insert_after: doctype === "Item" ? "disabled" : "append",
        in_standard_filter: 1,
        description:
            mode === "deny"
                ? "Which way this document syncs with the Medusa store. None keeps it out."
                : "Which way this document syncs with the Medusa store. Leave it on None to keep it out.",
    }
}

/** The fields an update may carry. `insert_after` is deliberately absent:
 *  Frappe rewrites "append" to a real fieldname, so it never compares equal. */
export const CUSTOM_FIELD_MUTABLE = ["label", "options", "default", "in_standard_filter", "description"] as const

export function buildWebhook(args: {
    doctype: string
    event: WebhookEvent
    publicUrl: string
    secret: string
    /** Overrides the selection conditions; "" means no condition. */
    condition?: string
}): Record<string, any> {
    return {
        doctype: "Webhook",
        name: webhookName(args.doctype, args.event),
        webhook_doctype: args.doctype,
        webhook_docevent: args.event,
        enabled: 1,
        request_url: inboundUrl(args.publicUrl),
        is_dynamic_url: 0,
        request_method: "POST",
        request_structure: "JSON",
        webhook_json: webhookJsonTemplate(args.event),
        condition:
            args.condition !== undefined
                ? args.condition
                : args.event === "on_trash"
                  ? ON_TRASH_CONDITION
                  : ON_UPDATE_CONDITION,
        enable_security: 1,
        webhook_secret: args.secret,
        timeout: 15,
        webhook_headers: [
            { doctype: "Webhook Header", key: "Content-Type", value: "application/json" },
        ],
    }
}

/** Never sent to an existing Webhook: Frappe refuses to change them. */
export const WEBHOOK_SET_ONCE = ["doctype", "name", "webhook_doctype", "webhook_docevent"] as const

export function webhookUpdatePayload(desired: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(desired)) {
        if (!(WEBHOOK_SET_ONCE as readonly string[]).includes(k)) out[k] = v
    }
    return out
}

function stable(value: any): any {
    if (Array.isArray(value)) return value.map(stable)
    if (value && typeof value === "object") {
        return Object.keys(value)
            .sort()
            .reduce((acc: Record<string, any>, k) => {
                acc[k] = stable(value[k])
                return acc
            }, {})
    }
    return value
}

/** Of everything we would send, secret included. */
export function fingerprintOf(payload: Record<string, any>): string {
    return crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex")
}

export type SetupAction = "created" | "updated" | "unchanged" | "error"

export type SetupItem = {
    kind: "custom_field" | "webhook" | "supplier" | "item" | "account"
    doctype: string
    name: string
    action: SetupAction
    detail?: string
    error?: string
    fingerprint?: string
}

export type SetupReport = {
    at: string
    ok: boolean
    public_url: string
    inbound_url: string
    items: SetupItem[]
}

export function describeSetupFailure(res: Extract<FrappeResult, { ok: false }>): string {
    if (res.status === 403) return "API user needs the System Manager role (ERPNext answered 403)"
    if (res.status === 401) return "ERPNext rejected the API key (401)"
    if (res.status === 0) return `ERPNext unreachable: ${res.error}`
    return res.error
}

function sameText(a: any, b: any): boolean {
    return String(a ?? "").trim() === String(b ?? "").trim()
}

function sameFlag(a: any, b: any): boolean {
    return Number(a ?? 0) === Number(b ?? 0)
}

export function customFieldMatches(existing: Record<string, any>, desired: Record<string, any>): boolean {
    return (
        sameText(existing.label, desired.label) &&
        sameText(existing.fieldtype, desired.fieldtype) &&
        sameText(existing.options, desired.options) &&
        sameText(existing.default, desired.default) &&
        sameFlag(existing.in_standard_filter, desired.in_standard_filter) &&
        sameText(existing.description, desired.description)
    )
}

export function webhookMatches(existing: Record<string, any>, desired: Record<string, any>): boolean {
    const headersOf = (rows: any) =>
        (Array.isArray(rows) ? rows : [])
            .map((r: any) => `${String(r?.key ?? "").trim()}=${String(r?.value ?? "").trim()}`)
            .sort()
            .join("\n")
    return (
        sameFlag(existing.enabled, desired.enabled) &&
        sameText(existing.request_url, desired.request_url) &&
        sameFlag(existing.is_dynamic_url, desired.is_dynamic_url) &&
        sameText(existing.request_method, desired.request_method) &&
        sameText(existing.request_structure, desired.request_structure) &&
        sameText(existing.webhook_json, desired.webhook_json) &&
        sameText(existing.condition, desired.condition) &&
        sameFlag(existing.enable_security, desired.enable_security) &&
        Number(existing.timeout ?? 0) === Number(desired.timeout ?? 0) &&
        headersOf(existing.webhook_headers) === headersOf(desired.webhook_headers)
    )
}

const CUSTOM_FIELD_PATH = "/api/resource/Custom%20Field"
const WEBHOOK_PATH = "/api/resource/Webhook"

export async function ensureCustomField(
    client: FrappeClient,
    doctype: string,
    mode: SyncMode,
): Promise<SetupItem> {
    const name = customFieldName(doctype)
    const desired = buildCustomField(doctype, mode)
    const item = (action: SetupAction, extra: Partial<SetupItem> = {}): SetupItem => ({
        kind: "custom_field",
        doctype,
        name,
        action,
        ...extra,
    })
    const got = await client.get(`${CUSTOM_FIELD_PATH}/${encodeURIComponent(name)}`)
    if (got.ok === false && got.status === 404) {
        const created = await client.post(CUSTOM_FIELD_PATH, desired)
        if (created.ok === false) return item("error", { error: describeSetupFailure(created) })
        return item("created", {
            detail:
                mode === "deny"
                    ? `default "${DIRECTION_BOTH}": every existing document now syncs both ways`
                    : `default "${DIRECTION_NONE}": choose a direction on the documents to sync`,
        })
    }
    if (got.ok === false) return item("error", { error: describeSetupFailure(got) })
    const existing = got.data ?? {}
    if (!sameText(existing.fieldtype, "Select")) {
        return item("error", {
            error: `${name} exists with fieldtype ${existing.fieldtype}; expected Select — delete it in ERPNext and run again`,
        })
    }
    if (customFieldMatches(existing, desired)) return item("unchanged")
    const patch: Record<string, any> = {}
    for (const k of CUSTOM_FIELD_MUTABLE) patch[k] = desired[k]
    const put = await client.put(`${CUSTOM_FIELD_PATH}/${encodeURIComponent(name)}`, patch)
    if (put.ok === false) return item("error", { error: describeSetupFailure(put) })
    return item("updated", { detail: `existing documents keep their current value; a blank one counts as ${DIRECTION_NONE}` })
}

export async function ensureWebhook(
    client: FrappeClient,
    desired: Record<string, any>,
    previous?: SetupItem | null,
): Promise<SetupItem> {
    const name = String(desired.name)
    const doctype = String(desired.webhook_doctype)
    const fingerprint = fingerprintOf(desired)
    const item = (action: SetupAction, extra: Partial<SetupItem> = {}): SetupItem => ({
        kind: "webhook",
        doctype,
        name,
        action,
        fingerprint,
        ...extra,
    })
    const got = await client.get(`${WEBHOOK_PATH}/${encodeURIComponent(name)}`)
    if (got.ok === false && got.status === 404) {
        const created = await client.post(WEBHOOK_PATH, desired)
        if (created.ok === false) return item("error", { error: describeSetupFailure(created) })
        return item("created")
    }
    if (got.ok === false) return item("error", { error: describeSetupFailure(got) })
    const existing = got.data ?? {}
    if (
        !sameText(existing.webhook_doctype, desired.webhook_doctype) ||
        !sameText(existing.webhook_docevent, desired.webhook_docevent)
    ) {
        return item("error", {
            error: `${name} exists for ${existing.webhook_doctype} ${existing.webhook_docevent}; rename or delete it in ERPNext`,
        })
    }
    if (webhookMatches(existing, desired) && previous?.fingerprint === fingerprint) {
        return item("unchanged")
    }
    const put = await client.put(`${WEBHOOK_PATH}/${encodeURIComponent(name)}`, webhookUpdatePayload(desired))
    if (put.ok === false) return item("error", { error: describeSetupFailure(put) })
    return item("updated")
}

function previousItem(report: SetupReport | null | undefined, kind: SetupItem["kind"], name: string) {
    return (report?.items ?? []).find((i) => i.kind === kind && i.name === name) ?? null
}

/**
 * The whole sequence for every selection DocType. Item-level failures
 * land in the report rather than throwing, so one DocType's trouble does
 * not hide what happened to the others.
 */
/**
 * Stock, ERPNext → Medusa: a ledger entry at the store's warehouse, and a
 * Sales Order submit or cancel (reserved quantity moves with no ledger
 * entry; the lines are filtered on arrival, since a condition cannot walk
 * a child table without builtins).
 */
export function buildStockWebhooks(args: { warehouse: string; publicUrl: string; secret: string }): Record<string, any>[] {
    const base = { publicUrl: args.publicUrl, secret: args.secret }
    return [
        buildWebhook({ ...base, doctype: STOCK_LEDGER_DOCTYPE, event: "after_insert", condition: stockLedgerCondition(args.warehouse) }),
        buildWebhook({ ...base, doctype: SALES_ORDER_DOCTYPE, event: "on_submit", condition: "" }),
        buildWebhook({ ...base, doctype: SALES_ORDER_DOCTYPE, event: "on_cancel", condition: "" }),
    ]
}

/** Prices, ERPNext → Medusa: a selling price on the store's list. */
export function buildPriceWebhooks(args: { priceList: string; publicUrl: string; secret: string }): Record<string, any>[] {
    const base = { publicUrl: args.publicUrl, secret: args.secret }
    return [
        buildWebhook({ ...base, doctype: ITEM_PRICE_DOCTYPE, event: "on_update", condition: itemPriceCondition(args.priceList) }),
        buildWebhook({ ...base, doctype: ITEM_PRICE_DOCTYPE, event: "on_trash", condition: itemPriceCondition(args.priceList) }),
    ]
}

/** The wallet and credit webhooks: a submitted Wallet Transaction not
 *  written by this store, a Wallet status change, and (with credit) a
 *  customer's Loan. See ./wallet-sync.ts for the conditions. */
export function buildWalletWebhooks(args: { wallet: boolean; credit: boolean; publicUrl: string; secret: string }): Record<string, any>[] {
    const base = { publicUrl: args.publicUrl, secret: args.secret }
    return walletWebhookSpecs({ wallet: args.wallet, credit: args.credit }).map((s) =>
        buildWebhook({ ...base, doctype: s.doctype, event: s.event, condition: s.condition }),
    )
}

/**
 * Invoices, ERPNext → Medusa: a Sales Invoice submitted or cancelled.
 * Unconditioned; whether it bills a store order is decided on arrival.
 */
export function buildInvoiceWebhooks(args: { publicUrl: string; secret: string }): Record<string, any>[] {
    const base = { publicUrl: args.publicUrl, secret: args.secret }
    return [
        buildWebhook({ ...base, doctype: SALES_INVOICE_DOCTYPE, event: "on_submit", condition: "" }),
        buildWebhook({ ...base, doctype: SALES_INVOICE_DOCTYPE, event: "on_cancel", condition: "" }),
    ]
}

// ─────────────────────────────────────────────────────────────────────
// Gateway settlements: the masters the fee invoice and payout need
// ─────────────────────────────────────────────────────────────────────

export const GATEWAY_EXPENSE_ACCOUNT = "Payment Gateway Charges"

export type SettlementMasters = {
    company: string
    gateways: Array<{ supplier: string; item: string; gst_hsn_code: string }>
    /** The ledger payouts land in; `create` makes it under Bank Accounts when missing. */
    bankAccount: { name: string; create: boolean } | null
}

const resourcePath = (doctype: string, name?: string) =>
    `/api/resource/${encodeURIComponent(doctype)}${name ? `/${encodeURIComponent(name)}` : ""}`

async function firstName(client: FrappeClient, doctype: string, filters: any[]): Promise<FrappeResult & { name?: string | null }> {
    const res = await client.get(resourcePath(doctype), {
        fields: JSON.stringify(["name"]),
        filters: JSON.stringify(filters),
        limit_page_length: "1",
    })
    if (res.ok === false) return res
    const name = Array.isArray(res.data) ? res.data[0]?.name : null
    return { ...res, name: name ? String(name) : null }
}

async function singleValue(client: FrappeClient, doctype: string, field: string): Promise<string | null> {
    const res = await client.get("/api/method/frappe.client.get_single_value", { doctype, field })
    return res.ok === true && res.data ? String(res.data) : null
}

/** A group ledger of the company, by its account name, else by its account type. */
async function groupAccount(client: FrappeClient, company: string, accountName: string, accountType?: string): Promise<string | null> {
    const byName = await firstName(client, "Account", [
        ["account_name", "=", accountName],
        ["company", "=", company],
        ["is_group", "=", 1],
    ])
    if (byName.ok === true && byName.name) return byName.name
    if (!accountType) return null
    const byType = await firstName(client, "Account", [
        ["account_type", "=", accountType],
        ["company", "=", company],
        ["is_group", "=", 1],
    ])
    return byType.ok === true && byType.name ? byType.name : null
}

/** The fee's expense ledger, "Payment Gateway Charges - <abbr>" under Indirect Expenses. */
async function ensureGatewayExpenseAccount(client: FrappeClient, company: string): Promise<{ item: SetupItem; account: string | null }> {
    const item = (action: SetupAction, name: string, extra: Partial<SetupItem> = {}): SetupItem => ({
        kind: "account",
        doctype: "Account",
        name,
        action,
        ...extra,
    })
    const found = await firstName(client, "Account", [
        ["account_name", "=", GATEWAY_EXPENSE_ACCOUNT],
        ["company", "=", company],
    ])
    if (found.ok === false) return { item: item("error", GATEWAY_EXPENSE_ACCOUNT, { error: describeSetupFailure(found) }), account: null }
    if (found.name) return { item: item("unchanged", found.name), account: found.name }
    const parent = await groupAccount(client, company, "Indirect Expenses")
    if (!parent) {
        return {
            item: item("error", GATEWAY_EXPENSE_ACCOUNT, { error: `no "Indirect Expenses" group in ${company}'s chart of accounts; create the expense account by hand` }),
            account: null,
        }
    }
    const created = await client.post(resourcePath("Account"), {
        doctype: "Account",
        account_name: GATEWAY_EXPENSE_ACCOUNT,
        parent_account: parent,
        company,
        is_group: 0,
    })
    if (created.ok === false) return { item: item("error", GATEWAY_EXPENSE_ACCOUNT, { error: describeSetupFailure(created) }), account: null }
    const name = String(created.data?.name ?? GATEWAY_EXPENSE_ACCOUNT)
    return { item: item("created", name, { detail: `under ${parent}; the service item books the fee here` }), account: name }
}

/** The bank ledger payouts land in. Made only when Settings ask for it; never changed. */
async function ensureSettlementBankAccount(
    client: FrappeClient,
    company: string,
    abbr: string | null,
    bank: { name: string; create: boolean },
): Promise<SetupItem> {
    const item = (action: SetupAction, extra: Partial<SetupItem> = {}): SetupItem => ({
        kind: "account",
        doctype: "Account",
        name: bank.name,
        action,
        ...extra,
    })
    const got = await client.get(resourcePath("Account", bank.name))
    if (got.ok === true) {
        return got.data?.account_type && got.data.account_type !== "Bank"
            ? item("unchanged", { detail: `its account type is ${got.data.account_type}, not Bank; left as it is` })
            : item("unchanged")
    }
    if (got.status !== 404) return item("error", { error: describeSetupFailure(got) })
    if (!bank.create) {
        return item("error", { error: "the settlement bank account is not in ERPNext; create it, or let Set up ERPNext create it (Settings)" })
    }
    const suffix = abbr ? ` - ${abbr}` : ""
    const accountName = suffix && bank.name.endsWith(suffix) ? bank.name.slice(0, -suffix.length) : bank.name
    const parent = await groupAccount(client, company, "Bank Accounts", "Bank")
    if (!parent) return item("error", { error: `no Bank Accounts group in ${company}'s chart of accounts` })
    const created = await client.post(resourcePath("Account"), {
        doctype: "Account",
        account_name: accountName,
        parent_account: parent,
        company,
        account_type: "Bank",
        is_group: 0,
    })
    if (created.ok === false) return item("error", { error: describeSetupFailure(created) })
    const name = String(created.data?.name ?? bank.name)
    return name === bank.name
        ? item("created", { detail: `Bank ledger under ${parent}` })
        : item("created", { name, detail: `Bank ledger under ${parent}, named ${name}: put that name in Settings` })
}

/** The gateway as a Supplier, found by name or supplier_name. Its GSTIN and address are the owner's to fill. */
async function ensureGatewaySupplier(client: FrappeClient, supplier: string, group: string): Promise<SetupItem> {
    const itcNote = "fill its GSTIN and billing address in ERPNext: India Compliance takes the purchase GST from them, and the input tax credit (GSTR-2B, GSTR-3B) needs them"
    const item = (action: SetupAction, extra: Partial<SetupItem> = {}): SetupItem => ({
        kind: "supplier",
        doctype: "Supplier",
        name: supplier,
        action,
        ...extra,
    })
    let got = await client.get(resourcePath("Supplier", supplier))
    if (got.ok === false && got.status === 404) {
        const byTitle = await firstName(client, "Supplier", [["supplier_name", "=", supplier]])
        if (byTitle.ok === false) return item("error", { error: describeSetupFailure(byTitle) })
        if (byTitle.name) got = await client.get(resourcePath("Supplier", byTitle.name))
    }
    if (got.ok === true) {
        const name = String(got.data?.name ?? supplier)
        return got.data?.gstin ? item("unchanged", { name }) : item("unchanged", { name, detail: `no GSTIN yet: ${itcNote}` })
    }
    if (got.status !== 404) return item("error", { error: describeSetupFailure(got) })
    const created = await client.post(resourcePath("Supplier"), {
        doctype: "Supplier",
        supplier_name: supplier,
        supplier_group: group,
        supplier_type: "Company",
        country: "India",
    })
    if (created.ok === false) return item("error", { error: describeSetupFailure(created) })
    return item("created", { name: String(created.data?.name ?? supplier), detail: `in ${group}; ${itcNote}` })
}

/** The fee as a non-stock purchase service Item. An existing Item is left as it is. */
async function ensureGatewayItem(
    client: FrappeClient,
    args: { item: string; hsn: string; company: string; expenseAccount: string | null; itemGroup: string },
): Promise<SetupItem> {
    const item = (action: SetupAction, extra: Partial<SetupItem> = {}): SetupItem => ({
        kind: "item",
        doctype: "Item",
        name: args.item,
        action,
        ...extra,
    })
    const got = await client.get(resourcePath("Item", args.item))
    if (got.ok === true) {
        const hsn = String(got.data?.gst_hsn_code ?? "")
        return hsn && hsn !== args.hsn ? item("unchanged", { detail: `its HSN/SAC is ${hsn}; left as it is` }) : item("unchanged")
    }
    if (got.status !== 404) return item("error", { error: describeSetupFailure(got) })
    const created = await client.post(resourcePath("Item"), {
        doctype: "Item",
        item_code: args.item,
        item_name: args.item,
        item_group: args.itemGroup,
        description: "Charges deducted by a payment gateway from its settlements",
        stock_uom: "Nos",
        is_stock_item: 0,
        include_item_in_manufacturing: 0,
        is_fixed_asset: 0,
        is_purchase_item: 1,
        is_sales_item: 0,
        gst_hsn_code: args.hsn,
        item_defaults: args.expenseAccount ? [{ company: args.company, expense_account: args.expenseAccount }] : [],
    })
    if (created.ok === false) return item("error", { error: describeSetupFailure(created) })
    return item("created", {
        detail: `non-stock service in ${args.itemGroup}, HSN/SAC ${args.hsn}: confirm the code against the gateway's tax invoices`,
    })
}

/**
 * What booking gateway settlements needs on the ERPNext side, created
 * only when missing: the fee's expense account, the settlement bank
 * account (when asked), each gateway's Supplier and service Item.
 * Nothing that exists is changed.
 */
export async function ensureSettlementMasters(client: FrappeClient, args: SettlementMasters): Promise<SetupItem[]> {
    const items: SetupItem[] = []
    if (!args.company) {
        return [{ kind: "account", doctype: "Company", name: "(none)", action: "error", error: "no company: set one in Settings or ERPNext's Global Defaults" }]
    }
    const company = await client.get(resourcePath("Company", args.company))
    if (company.ok === false) {
        return [{ kind: "account", doctype: "Company", name: args.company, action: "error", error: describeSetupFailure(company) }]
    }
    const abbr = company.data?.abbr ? String(company.data.abbr) : null
    const expense = await ensureGatewayExpenseAccount(client, args.company)
    items.push(expense.item)
    if (args.bankAccount?.name) items.push(await ensureSettlementBankAccount(client, args.company, abbr, args.bankAccount))

    const supplierGroup = (await singleValue(client, "Buying Settings", "supplier_group")) ?? "All Supplier Groups"
    const services = await client.get(resourcePath("Item Group", "Services"))
    const itemGroup = services.ok === true ? "Services" : ((await singleValue(client, "Stock Settings", "item_group")) ?? "All Item Groups")
    const seenSuppliers = new Set<string>()
    const seenItems = new Set<string>()
    for (const g of args.gateways) {
        if (!seenSuppliers.has(g.supplier)) {
            seenSuppliers.add(g.supplier)
            items.push(await ensureGatewaySupplier(client, g.supplier, supplierGroup))
        }
        if (!seenItems.has(g.item)) {
            seenItems.add(g.item)
            items.push(
                await ensureGatewayItem(client, { item: g.item, hsn: g.gst_hsn_code, company: args.company, expenseAccount: expense.account, itemGroup }),
            )
        }
    }
    return items
}

export async function runErpnextSetup(args: {
    client: FrappeClient
    doctypes: SyncDoctype[]
    publicUrl: string
    secret: string
    previous?: SetupReport | null
    /** Stock sync is on and the store's warehouse is set. */
    stock?: { warehouse: string } | null
    /** Price sync is on and the selling price list is known. */
    prices?: { priceList: string } | null
    /** Wallet sync is on; the credit line as well when `credit` is true. */
    wallet?: { credit: boolean } | null
    /** Customers are sent ERPNext's invoices. */
    invoices?: boolean
    /** DocTypes that hang off a synced one (a Customer's Contact): one
     *  on_update webhook each, unconditioned — whether the document is
     *  linked to a synced one is decided on arrival. */
    secondaries?: string[] | null
    /** Gateway settlements are booked: their supplier, item and accounts. */
    settlements?: SettlementMasters | null
}): Promise<SetupReport> {
    const items: SetupItem[] = []
    for (const { doctype, mode } of args.doctypes) {
        const field = await ensureCustomField(args.client, doctype, mode)
        items.push(field)
        for (const event of WEBHOOK_EVENTS) {
            const desired = buildWebhook({ doctype, event, publicUrl: args.publicUrl, secret: args.secret })
            if (field.action === "error") {
                items.push({
                    kind: "webhook",
                    doctype,
                    name: String(desired.name),
                    action: "error",
                    error: "not attempted: the custom field could not be created",
                })
                continue
            }
            items.push(
                await ensureWebhook(args.client, desired, previousItem(args.previous, "webhook", String(desired.name))),
            )
        }
    }
    const underSelection = new Set(args.doctypes.map((d) => d.doctype))
    const extra = [
        ...(args.stock ? buildStockWebhooks({ warehouse: args.stock.warehouse, publicUrl: args.publicUrl, secret: args.secret }) : []),
        ...(args.prices ? buildPriceWebhooks({ priceList: args.prices.priceList, publicUrl: args.publicUrl, secret: args.secret }) : []),
        ...(args.wallet ? buildWalletWebhooks({ wallet: true, credit: args.wallet.credit, publicUrl: args.publicUrl, secret: args.secret }) : []),
        ...(args.invoices ? buildInvoiceWebhooks({ publicUrl: args.publicUrl, secret: args.secret }) : []),
        ...(args.secondaries ?? [])
            .filter((dt, i, all) => dt && !underSelection.has(dt) && all.indexOf(dt) === i)
            .map((dt) => buildWebhook({ doctype: dt, event: "on_update", publicUrl: args.publicUrl, secret: args.secret, condition: "" })),
    ]
    for (const desired of extra) {
        items.push(await ensureWebhook(args.client, desired, previousItem(args.previous, "webhook", String(desired.name))))
    }
    if (args.settlements) items.push(...(await ensureSettlementMasters(args.client, args.settlements)))
    return {
        at: new Date().toISOString(),
        ok: items.every((i) => i.action !== "error"),
        public_url: args.publicUrl,
        inbound_url: inboundUrl(args.publicUrl),
        items,
    }
}
