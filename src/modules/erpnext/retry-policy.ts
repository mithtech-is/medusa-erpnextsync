/**
 * Which sync rows the retry job owes another attempt.
 *
 * A row skipped on purpose — an echo, no mapping, a trigger that said no,
 * an unchanged payload — records a decision, not a failure, and retrying
 * it would only take the same decision again until the row poisons. A
 * failed write is owed a retry; so is a row a crash left "pending".
 *
 * A push row also goes stale: every manual or event-driven push writes
 * its own row with a snapshot of the record, and an older failed row for
 * the same record and mapping would resend that older snapshot — at worst
 * alongside a live push of the same record, which is how a Sales Order
 * gets created twice. Only the newest row per record and mapping is
 * retried; the rest are superseded.
 */

export type RetryRow = {
    id?: string
    status?: string | null
    direction?: string | null
    is_test?: boolean | null
    entity_ref?: string | null
    mapping_id?: string | null
    created_at?: Date | string | null
}

export function owedRetry(row: RetryRow): boolean {
    if (row?.is_test) return false
    return row?.status === "failed" || row?.status === "pending"
}

export const SUPERSEDED_MESSAGE = "superseded by a later push of the same record; not retried"

/** True when `rows` holds a newer push row for the same record and mapping. */
export function supersededByLater(row: RetryRow, rows: RetryRow[]): boolean {
    if (!row?.entity_ref || !row?.mapping_id || !row?.created_at) return false
    const mine = new Date(row.created_at).getTime()
    return (rows ?? []).some(
        (r) =>
            r !== row &&
            r?.id !== row.id &&
            r?.entity_ref === row.entity_ref &&
            r?.mapping_id === row.mapping_id &&
            (r?.direction ?? "outbound") !== "inbound" &&
            r?.created_at != null &&
            new Date(r.created_at).getTime() > mine,
    )
}
