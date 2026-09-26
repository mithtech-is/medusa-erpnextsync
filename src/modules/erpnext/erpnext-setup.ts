import crypto from "crypto"
import type { FrappeClient, FrappeResult } from "./frappe-client"
import { SELECTION_FIELD, type SyncDoctype, type SyncMode } from "./selection"

/**
 * "Set up ERPNext": everything this plugin needs on the ERPNext side,
 * created over REST so nobody clicks through Desk.
 *
 * Per selection DocType, in this order:
 *   1. Custom Field `<DocType>-medusa_sync` (Check, "Sync to Medusa").
 *      First, because a Webhook's condition is validated against a blank
 *      document when the Webhook is saved.
 *   2. Webhook `Medusa Sync: <DocType> on_update` — fires when the
 *      document is ticked, or was ticked before this save (so an untick
 *      arrives once and drafts the product). `on_update` also runs on
 *      insert, so no `after_insert` hook is needed.
 *   3. Webhook `Medusa Sync: <DocType> on_trash` — fires for a ticked
 *      document being deleted.
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

export type WebhookEvent = "on_update" | "on_trash"
export const WEBHOOK_EVENTS: WebhookEvent[] = ["on_update", "on_trash"]

export const CUSTOM_FIELD_LABEL = "Sync to Medusa"

/** Fires for a document that is ticked now or was ticked before this
 *  save. `get_doc_before_save()` is None on insert and on the blank
 *  document Frappe validates the condition against; `and` short-circuits. */
export const ON_UPDATE_CONDITION =
    'doc.get("medusa_sync") or (doc.get_doc_before_save() and doc.get_doc_before_save().get("medusa_sync"))'

export const ON_TRASH_CONDITION = 'doc.get("medusa_sync")'

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
        fieldtype: "Check",
        default: mode === "deny" ? "1" : "0",
        // Item keeps it next to "Disabled" where a person looks for such
        // switches; any other DocType gets it at the end.
        insert_after: doctype === "Item" ? "disabled" : "append",
        in_standard_filter: 1,
        description:
            mode === "deny"
                ? "Untick to keep this document out of the Medusa store."
                : "Tick to publish this document to the Medusa store.",
    }
}

/** The fields an update may carry. `insert_after` is deliberately absent:
 *  Frappe rewrites "append" to a real fieldname, so it never compares equal. */
export const CUSTOM_FIELD_MUTABLE = ["label", "default", "in_standard_filter", "description"] as const

export function buildWebhook(args: {
    doctype: string
    event: WebhookEvent
    publicUrl: string
    secret: string
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
        condition: args.event === "on_trash" ? ON_TRASH_CONDITION : ON_UPDATE_CONDITION,
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
    kind: "custom_field" | "webhook"
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
                    ? "default 1: every existing document is now ticked"
                    : "default 0: tick the documents to sync",
        })
    }
    if (got.ok === false) return item("error", { error: describeSetupFailure(got) })
    const existing = got.data ?? {}
    if (!sameText(existing.fieldtype, "Check")) {
        return item("error", { error: `${name} exists with fieldtype ${existing.fieldtype}; expected Check` })
    }
    if (customFieldMatches(existing, desired)) return item("unchanged")
    const patch: Record<string, any> = {}
    for (const k of CUSTOM_FIELD_MUTABLE) patch[k] = desired[k]
    const put = await client.put(`${CUSTOM_FIELD_PATH}/${encodeURIComponent(name)}`, patch)
    if (put.ok === false) return item("error", { error: describeSetupFailure(put) })
    return item("updated", { detail: "existing documents keep their current tick" })
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
export async function runErpnextSetup(args: {
    client: FrappeClient
    doctypes: SyncDoctype[]
    publicUrl: string
    secret: string
    previous?: SetupReport | null
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
    return {
        at: new Date().toISOString(),
        ok: items.every((i) => i.action !== "error"),
        public_url: args.publicUrl,
        inbound_url: inboundUrl(args.publicUrl),
        items,
    }
}
