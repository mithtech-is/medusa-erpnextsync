/**
 * Push a wallet_settlement change to ERPNext directly from an admin API route.
 *
 * The generic ERPNext connector normally reacts to Medusa events via its
 * forward-subscriber. But events emitted inside a plain API route are buffered
 * under the request's event group and never released (a route runs no workflow
 * to release them), so they are silently dropped. Rather than fight that, the
 * route calls the connector's `pushViaMapping` directly — the exact same code
 * path the subscriber uses (transform → signed POST → log into
 * erpnext_sync_event), just invoked synchronously. Inbound (ERPNext → Medusa)
 * is unaffected; it never relied on Medusa events.
 *
 * Errors are swallowed and logged: a slow/down ERPNext must never fail the
 * Medusa-side write (the connector's retry/reconcile picks up the gap).
 */
export async function syncWsToErpnext(
  scope: any,
  eventName: string,
  record: { id: string; [k: string]: any },
): Promise<void> {
  try {
    const erpnext: any = scope.resolve("erpnext")
    const mappings = await erpnext.listEnabledPushMappingsForEvent(
      "wallet_settlement",
      eventName,
    )
    for (const m of mappings) {
      const result = await erpnext.pushViaMapping({
        mapping: m,
        event: eventName,
        event_id: `medusa:${eventName}:${record.id}:${Date.now()}`,
        record,
      })
      if (!result?.ok) {
        console.error(
          `[wallet-settlement] push ${eventName} via ${m.name} failed: ${result?.error}`,
        )
      }
    }
  } catch (e: any) {
    console.error(`[wallet-settlement] push ${eventName} error: ${e?.message}`)
  }
}
