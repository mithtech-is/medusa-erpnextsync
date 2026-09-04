/**
 * When ERPNext is down, stop knocking.
 *
 * A Frappe site that has refused ten pushes in a row will refuse the
 * eleventh, and every attempt holds the request for the length of the
 * timeout. The retry job then re-posts the same rows on a schedule, so an
 * afternoon of downtime is an afternoon of waiting out timeouts.
 *
 * So: count consecutive failures, stop trying past a threshold, and let
 * one delivery through per retry run to find out whether it has come
 * back. One success closes it. The counter lives on `erpnext_setting`
 * rather than in a cache, because somebody looking at why nothing is
 * syncing should be able to see the answer on the connection.
 *
 * `medusync/breaker.py` is the mirror, and the two rules that are easy to
 * get wrong are the same on both sides: a rehearsal can neither trip it
 * nor close it — testing a mapping against a site that is down must not
 * take real traffic with it — and a probe must always be let through, or
 * it never learns the far side came back.
 *
 * No database in this file. That is deliberate: these are the rules, and
 * rules that can be tested exactly are rules worth having.
 */

/** Consecutive failures before the connection is left alone. */
export const DEFAULT_TRIP_AFTER = 10

export type BreakerRow = {
    consecutive_failures?: number | null
    tripped_at?: Date | string | null
    trip_after?: number | null
}

export type BreakerState = {
    consecutive_failures: number
    tripped: boolean
    tripped_at: Date | string | null
    trip_after: number
}

export function threshold(row: BreakerRow | null | undefined): number {
    const value = Number(row?.trip_after ?? 0)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TRIP_AFTER
}

export function stateOf(row: BreakerRow | null | undefined): BreakerState {
    return {
        consecutive_failures: Math.max(0, Number(row?.consecutive_failures ?? 0) || 0),
        tripped: Boolean(row?.tripped_at),
        tripped_at: row?.tripped_at ?? null,
        trip_after: threshold(row),
    }
}

export function isTripped(row: BreakerRow | null | undefined): boolean {
    return Boolean(row?.tripped_at)
}

/**
 * May this delivery go out?
 *
 * A rehearsal always may: the operator is deliberately testing this
 * connection, and answering "the breaker is open" while they are trying
 * to find out why is the wrong answer at the wrong moment. A probe always
 * may, because somebody has to knock.
 */
export function allows(
    row: BreakerRow | null | undefined,
    opts: { isTest?: boolean; probe?: boolean } = {},
): boolean {
    if (opts.isTest || opts.probe) return true
    return !isTripped(row)
}

/**
 * The columns to write after a failure. Returns null when there is
 * nothing to write, so a caller can skip the round trip.
 */
export function afterFailure(
    row: BreakerRow | null | undefined,
    opts: { isTest?: boolean } = {},
): Partial<BreakerRow> | null {
    if (opts.isTest) return null
    const next = stateOf(row).consecutive_failures + 1
    const patch: Partial<BreakerRow> = { consecutive_failures: next }
    if (next >= threshold(row) && !isTripped(row)) {
        patch.tripped_at = new Date()
    }
    return patch
}

/** The columns to write after a success, or null when nothing changed. */
export function afterSuccess(
    row: BreakerRow | null | undefined,
    opts: { isTest?: boolean } = {},
): Partial<BreakerRow> | null {
    if (opts.isTest) return null
    const state = stateOf(row)
    if (state.consecutive_failures === 0 && !state.tripped) return null
    return { consecutive_failures: 0, tripped_at: null }
}
