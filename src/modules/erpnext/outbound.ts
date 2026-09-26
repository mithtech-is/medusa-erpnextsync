/**
 * Medusa → ERPNext can be paused.
 *
 * Pushes run over plain Frappe REST. Set `ERPNEXT_PAUSE_PUSH=true` to stop
 * them without touching the mappings: every push mapping is still
 * evaluated (policy, trigger, allowlist, transform) and then stops, on
 * record, so nothing is lost and nothing leaves.
 */
export const OUTBOUND_PAUSED = process.env.ERPNEXT_PAUSE_PUSH === "true"

export const OUTBOUND_PAUSED_REASON = "outbound-paused"

export const OUTBOUND_PAUSED_MESSAGE =
    "Pushes to ERPNext are paused (ERPNEXT_PAUSE_PUSH=true); ERPNext → Medusa is live."

export function pausedResult(): {
    ok: true
    status: "skipped"
    reason: typeof OUTBOUND_PAUSED_REASON
    message: string
} {
    return { ok: true, status: "skipped", reason: OUTBOUND_PAUSED_REASON, message: OUTBOUND_PAUSED_MESSAGE }
}
