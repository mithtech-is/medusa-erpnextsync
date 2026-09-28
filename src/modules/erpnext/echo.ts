/**
 * Loop prevention that outlives the request.
 *
 * An inbound write from ERPNext lands as an ordinary module write. The
 * Medusa event it emits reaches the forward subscriber in a LATER
 * request, where no in-memory guard survives, and would push the same
 * values straight back. So the inbound row records which Medusa record it
 * touched; an outbound push that finds a recent one knows it is an echo
 * and says so in its envelope, and the far side drops it.
 *
 * Both helpers are pure so the rule can be tested without a database.
 */

/**
 * How far back an inbound write still counts as the cause of an outbound
 * push. Long enough for a worker to pick the event up, short enough that
 * a person editing the same record a minute later is not mistaken for an
 * echo and silently dropped.
 */
export const ECHO_WINDOW_MS = 180_000

/**
 * Which Medusa record an inbound apply actually wrote, as
 * `<entity>:<id>` — or null when it wrote none.
 *
 * Only the mapping-driven path reports this today; the domain handlers
 * write order metadata, which nothing forwards back.
 */
export function entityRefOf(result: any): string | null {
    const rows = Array.isArray(result?.results) ? result.results : []
    for (const row of rows) {
        if (row?.ok !== false && row?.entity && row?.id) {
            return `${String(row.entity)}:${String(row.id)}`
        }
    }
    return null
}

/**
 * Is an inbound row recent enough to have caused the push we are about to
 * send?
 *
 * The timestamp that matters is when the row was last WORKED, not when it
 * was first created: an inbound row is reused across retries, so a row
 * created an hour ago and applied ten seconds ago is a live cause.
 */
export function isWithinEchoWindow(
    at: Date | string | null | undefined,
    now = Date.now(),
    window = ECHO_WINDOW_MS,
): boolean {
    if (!at) return false
    const t = at instanceof Date ? at.getTime() : new Date(at).getTime()
    if (!Number.isFinite(t)) return false
    return now - t <= window && now - t >= -window
}

/**
 * Does a push carry anything the ERPNext document does not already hold?
 *
 * Time alone cannot tell an echo from a person: someone editing the record
 * here a minute after ERPNext changed it is inside the window too, and
 * dropping that edit loses it for good. An echo repeats what ERPNext just
 * wrote, so it changes nothing there; anything that would change a field
 * is a real edit and must travel. A document that could not be read counts
 * as changed.
 */
export function pushChangesRemote(
    payload: Record<string, any> | null | undefined,
    remote: Record<string, any> | null | undefined,
): boolean {
    if (!remote) return true
    for (const [field, value] of Object.entries(payload ?? {})) {
        if (value === undefined) continue
        if (!sameRemoteValue(value, remote[field])) return true
    }
    return false
}

/** Frappe answers 0/1 for a Check, numbers for a Float and "" or null for
 *  an empty field, whatever the push sent; compare what the values mean. */
function sameRemoteValue(ours: unknown, theirs: unknown): boolean {
    const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "")
    if (blank(ours) || blank(theirs)) return blank(ours) && blank(theirs)
    if (typeof ours === "object" || typeof theirs === "object") return JSON.stringify(ours) === JSON.stringify(theirs)
    const a = String(ours).trim()
    const b = String(theirs).trim()
    if (a === b) return true
    const na = Number(a)
    const nb = Number(b)
    if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb
    if (typeof ours === "boolean" || typeof theirs === "boolean") return Boolean(ours) === (b === "1" || b === "true")
    return false
}
