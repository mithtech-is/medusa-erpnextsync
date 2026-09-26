import crypto from "crypto"
import { z } from "zod"
import { selectionOf } from "./selection"

/**
 * The inbound side of a Frappe core Webhook.
 *
 * Frappe signs `frappe.as_json(data)` with HMAC-SHA256 and sends the
 * standard-base64 digest in `X-Frappe-Webhook-Signature`; the request body
 * is that same string, so the digest is verified over the raw bytes and
 * never over anything re-serialised here. Two consequences the setup code
 * takes care of: the Webhook row must add a `Content-Type: application/json`
 * header (Frappe sends none, and without it Medusa does not keep the raw
 * body), and the body shape is whatever the Webhook's template says — ours
 * is `{event, doctype, name, doc}` with the whole document under `doc`.
 *
 * Pure: the route and the retry job both go through here.
 */

export const FRAPPE_SIGNATURE_HEADER = "x-frappe-webhook-signature"

/** Constant-time string equality; unequal lengths are simply unequal. */
export function safeEq(a: string, b: string): boolean {
    const ab = Buffer.from(String(a ?? ""), "utf8")
    const bb = Buffer.from(String(b ?? ""), "utf8")
    if (ab.length !== bb.length) return false
    return crypto.timingSafeEqual(ab, bb)
}

/** What Frappe puts in the header for this body and secret. */
export function frappeSignature(rawBody: Buffer, secret: string): string {
    return crypto.createHmac("sha256", secret).update(rawBody).digest("base64")
}

export function verifyFrappeSignature(args: {
    rawBody: Buffer | null | undefined
    header: string | string[] | null | undefined
    secret: string | null | undefined
}): boolean {
    const header = Array.isArray(args.header) ? args.header[0] : args.header
    if (!args.rawBody || !header || !args.secret) return false
    const presented = String(header).trim()
    if (!presented) return false
    const mac = crypto.createHmac("sha256", args.secret).update(args.rawBody)
    const digest = mac.digest()
    // Frappe sends base64. Hex is accepted so a hand-made curl can sign
    // with `openssl dgst -sha256 -hmac`.
    return safeEq(presented, digest.toString("base64")) || safeEq(presented, digest.toString("hex"))
}

export const FrappeWebhookEvent = z.enum(["on_update", "on_trash"])
export type FrappeWebhookEvent = z.infer<typeof FrappeWebhookEvent>

const nameLike = z.union([z.string(), z.number()]).transform((v) => String(v))

export const FrappeWebhookBody = z.object({
    event: FrappeWebhookEvent,
    doctype: z.string().min(1),
    name: nameLike.pipe(z.string().min(1)),
    doc: z.record(z.any()),
})
export type FrappeWebhookBody = z.infer<typeof FrappeWebhookBody>

export function parseFrappeWebhookBody(
    raw: Buffer | string | unknown,
): { ok: true; body: FrappeWebhookBody } | { ok: false; message: string } {
    let parsed: unknown = raw
    if (Buffer.isBuffer(raw) || typeof raw === "string") {
        try {
            parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw)
        } catch {
            return { ok: false, message: "body is not JSON" }
        }
    }
    const res = FrappeWebhookBody.safeParse(parsed)
    if (!res.success) {
        const first = res.error.issues[0]
        const where = first?.path?.length ? first.path.join(".") : "body"
        return { ok: false, message: `${where}: ${first?.message ?? "invalid"}` }
    }
    return { ok: true, body: res.data }
}

/**
 * One id per (event, document, version). Frappe delivers a webhook up to
 * three times when we answer slowly; the same id lands on one sync row.
 */
export function frappeEventId(body: FrappeWebhookBody): string {
    const modified = body.doc?.modified != null ? String(body.doc.modified) : ""
    return `frappe:${body.event}:${body.doctype}:${body.name}:${modified}`
}

export type LinkLike = { medusa_id: string; state?: string | null } | null | undefined

export type FrappePlan =
    | { action: "upsert"; key: string; republish: boolean; reason: string }
    | { action: "draft"; by: "link"; medusa_id: string; key: string | null; reason: string }
    | { action: "draft"; by: "key"; key: string; reason: string }
    | { action: "skip"; reason: string }

/**
 * What one webhook means for one mapping.
 *
 * Trash → draft. Unticked → draft (the webhook only fires for an untick
 * when the document was ticked before, so the product is ours). Ticked →
 * upsert, republishing a product we drafted earlier. The key is the raw
 * value of the mapping's ERPNext key field, exactly as the pull uses it;
 * the entity decides how it matches (a handle is derived from an item
 * code by the product entity, not here).
 */
export function planFrappeEvent(args: {
    event: FrappeWebhookEvent
    doc: Record<string, any>
    mapping: { medusa_entity: string; key_erpnext_field: string }
    link: LinkLike
}): FrappePlan {
    const { event, doc, mapping, link } = args
    const rawKey = doc?.[mapping.key_erpnext_field]
    const key = rawKey != null && rawKey !== "" ? String(rawKey) : null

    if (event === "on_trash") {
        if (link?.medusa_id) return { action: "draft", by: "link", medusa_id: link.medusa_id, key, reason: "trashed in ERPNext" }
        if (key) return { action: "draft", by: "key", key, reason: "trashed in ERPNext; no link, matched by key" }
        return { action: "skip", reason: `trashed, but no value for key field '${mapping.key_erpnext_field}'` }
    }

    const selected = selectionOf(doc)
    if (selected === "absent") {
        return { action: "skip", reason: "document carries no medusa_sync field; run Set up ERPNext" }
    }
    if (selected === "off") {
        if (link?.medusa_id) return { action: "draft", by: "link", medusa_id: link.medusa_id, key, reason: "unticked in ERPNext" }
        if (key) return { action: "draft", by: "key", key, reason: "unticked in ERPNext; no link, matched by key" }
        return { action: "skip", reason: "unticked and never synced" }
    }
    if (!key) {
        return { action: "skip", reason: `no value for key field '${mapping.key_erpnext_field}'` }
    }
    const republish = mapping.medusa_entity === "product" && link?.state === "drafted"
    return {
        action: "upsert",
        key,
        republish,
        reason: republish ? "ticked again; republishing" : "ticked",
    }
}
