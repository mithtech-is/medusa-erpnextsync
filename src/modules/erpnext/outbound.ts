/**
 * Medusa → ERPNext is paused.
 *
 * The transport that carried pushes was the medusync envelope, and medusync
 * is retired. Phase 2 replaces it with plain REST writes. Until then every
 * push mapping is evaluated as before (policy, trigger, allowlist,
 * transform) and then stops here, recording what it would have sent, so
 * nothing is lost and nothing leaves.
 */
export const OUTBOUND_PAUSED = true

export const OUTBOUND_PAUSED_REASON = "outbound-paused"

export const OUTBOUND_PAUSED_MESSAGE =
    "Pushes to ERPNext are paused in this release; ERPNext → Medusa catalogue sync is live."

export function pausedResult(): {
    ok: true
    status: "skipped"
    reason: typeof OUTBOUND_PAUSED_REASON
    message: string
} {
    return { ok: true, status: "skipped", reason: OUTBOUND_PAUSED_REASON, message: OUTBOUND_PAUSED_MESSAGE }
}
