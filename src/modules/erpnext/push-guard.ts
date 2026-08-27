/**
 * Outbound gate — the last thing a record passes before it leaves
 * Medusa for ERPNext.
 *
 * Two independent rules, both fail-closed:
 *
 *   1. CANARY EXCLUSION (always on, not configurable).
 *      The platform runs an intentional honeytoken defence: a fake
 *      customer, a fake unlisted company and fake price history live in
 *      the real database, flagged `metadata.is_canary === "true"` on
 *      products and `metadata.__canary` on customers. Every
 *      customer-facing surface filters them out, and a sync to an
 *      external ERP is exactly such a surface — pushing a decoy into
 *      another system copies the trap somewhere nobody is watching it,
 *      and any later hit there reads as a real leak.
 *
 *   2. PUSH ALLOWLIST (opt-in, via erpnext_setting.push_allowlist).
 *      When configured, only records matching an entry go out. Intended
 *      for the case where a production Medusa is pointed at a
 *      non-production ERPNext during integration work: you want the
 *      real code path exercised on a handful of designated records
 *      without streaming everyone's personal data onto a test box.
 *
 * Pure functions, no I/O — the caller supplies the parsed allowlist so
 * this stays unit-testable without a database.
 */

/** Why a record was held back. Empty string when it wasn't. */
export type PushSkipReason = "" | "canary_record" | "not_in_allowlist"

/**
 * A flat shape rather than a discriminated union: every caller wants
 * both fields, and `reason: ""` on the allowed case reads no worse than
 * a narrowing dance at each call site.
 */
export type PushDecision = {
    allowed: boolean
    reason: PushSkipReason
}

/**
 * Identity values an allowlist entry may name. Kept deliberately small:
 * these are the identifiers an operator actually has to hand when
 * picking test records out of the admin.
 */
const IDENTITY_PATHS = [
    "id",
    "email",
    "handle",
    "display_id",
    "metadata.isin",
] as const

/**
 * Parse the raw textarea into a comparable set.
 *
 * Accepts newlines, commas or semicolons as separators so pasting from
 * a spreadsheet, a CSV cell or a chat message all work. Entries are
 * lowercased for case-insensitive comparison (Medusa ids are
 * case-sensitive in principle, but an operator retyping `CUS_...`
 * meaning `cus_...` is a far more likely event than a genuine collision
 * that differs only by case).
 */
export function parseAllowlist(raw: unknown): Set<string> {
    if (typeof raw !== "string" || !raw.trim()) return new Set()
    return new Set(
        raw
            .split(/[\n,;]+/)
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean),
    )
}

/** True when the record carries either canary marker. */
export function isCanaryRecord(record: any): boolean {
    const metadata = record?.metadata
    if (!metadata || typeof metadata !== "object") return false
    // Products use the string "true" (Medusa metadata values are text);
    // customers use a presence flag. Accept either shape on either, so a
    // marker never fails open because it was written the other way.
    const product = metadata.is_canary
    const customer = metadata.__canary
    return (
        product === true ||
        String(product ?? "").toLowerCase() === "true" ||
        customer === true ||
        String(customer ?? "").toLowerCase() === "true" ||
        (customer !== undefined && customer !== null && customer !== "")
    )
}

/**
 * Decide whether one record may be pushed.
 *
 * An empty allowlist means "no restriction" — that is the historical
 * behaviour and the default for every existing deployment.
 */
export function evaluatePush(
    record: any,
    allowlist: Set<string>,
): PushDecision {
    if (isCanaryRecord(record)) {
        return { allowed: false, reason: "canary_record" }
    }
    if (allowlist.size === 0) {
        return { allowed: true, reason: "" }
    }
    for (const path of IDENTITY_PATHS) {
        const value = readPath(record, path)
        if (value === null || value === undefined) continue
        if (allowlist.has(String(value).trim().toLowerCase())) {
            return { allowed: true, reason: "" }
        }
    }
    return { allowed: false, reason: "not_in_allowlist" }
}

/** Minimal dot-path read — the guard must not depend on the mapping
 *  engine, which imports it in turn. */
function readPath(source: any, path: string): unknown {
    let cursor = source
    for (const token of path.split(".")) {
        if (cursor === null || cursor === undefined) return undefined
        if (typeof cursor !== "object") return undefined
        cursor = cursor[token]
    }
    return cursor
}
