/**
 * Where the next pull starts.
 *
 * Frappe's `modified` is the site's wall time to the microsecond
 * ("2026-10-11 12:00:00.123456"). The mapping row keeps it as a Date by
 * reading that wall time as UTC, which a JavaScript Date can hold only to
 * the millisecond. Comparing `modified >` a shortened value matches the
 * newest record again, so every tick re-pulled it. The exact string is
 * kept beside the Date and is the bound whenever the two still agree.
 */

/** Frappe's `modified` as the Date the mapping row stores. */
export function watermarkDate(modified: string): Date {
    return new Date(String(modified).trim().replace(" ", "T") + "Z")
}

/**
 * The value for the pull's `["modified", ">", …]` filter, or null for a
 * full scan. The exact string is used only while it is the same instant
 * as `last_pull_at`; a watermark cleared or moved by anything else wins.
 */
export function modifiedAfter(
    lastPullAt: Date | string | null | undefined,
    lastPullModified: string | null | undefined,
): string | null {
    if (!lastPullAt) return null
    const at = new Date(lastPullAt)
    if (Number.isNaN(at.getTime())) return null
    if (lastPullModified && watermarkDate(lastPullModified).getTime() === at.getTime()) {
        return String(lastPullModified).trim()
    }
    return at.toISOString().slice(0, 23).replace("T", " ")
}

/** The newest of Frappe `modified` values. Frappe's fixed format sorts as text. */
export function latestModified(current: string | null, candidate: unknown): string | null {
    if (typeof candidate !== "string" || !candidate) return current
    return !current || candidate > current ? candidate : current
}
