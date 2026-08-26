# Wallet Settlement two-way sync — E2E results

**Date:** 2026-08-25. Built per `WALLET_SETTLEMENT_SYNC_PLAN.md`, verified live on
the demo stack (Medusa prod `:9000`, admin `:7001`, Frappe `site1.local`).

## PASS matrix (all green)

| # | Check | Result |
|---|---|---|
| 1 | Create in Medusa (admin API) → appears in ERPNext | ✅ `E2E-M2E-6` in ERPNext, `medusa_settlement_id` linked, figures match |
| 2 | Create in ERPNext → appears in Medusa | ✅ `E2E-E2M-1` in Medusa, all fields match (credits 3000, net 2000, Posted) |
| 3 | Edit amount Medusa → ERPNext | ✅ net 1000→7777 reflected in ERPNext |
| 4 | Edit status ERPNext → Medusa | ✅ Posted→Failed reflected in Medusa |
| 5 | Cancel from Medusa (DELETE) → ERPNext | ✅ ERPNext row **preserved**, status=Cancelled (never destroyed) |
| 6 | Cancel from ERPNext (status=Cancelled) → Medusa | ✅ Medusa row **preserved**, status=Cancelled |
| 7 | Regression: Customer create Medusa → ERPNext | ✅ still syncs (`[erpnext-sync] pushed customer`) |

## Key finding — why the outbound push needed a different approach

The design assumed the generic connector's **forward-subscriber** (which reacts
to Medusa events) would carry the Medusa→ERPNext push, as it does for
products. It does not fire for events emitted from a **plain admin API route**:

- Medusa buffers events emitted inside a request scope under the request's
  ambient `eventGroupId` and only releases them when a **workflow** completes.
  A plain route runs no workflow, so `eventBus.emit()` (and even
  `emitEventStep` in a one-step workflow) was staged and silently dropped —
  the subscriber never saw the event. Confirmed: emitting the same event from
  a fresh process (`medusa exec`) *did* reach the subscriber ("Processing
  wallet_settlement.created … 1 subscribers"); the route emit produced no
  processing line at all.
- Customer sync is unaffected because Medusa's **core** customer workflow emits
  `customer.created` correctly (and this sandbox also has its own
  `erpnext-customer-sync` subscriber).

**Fix:** the wallet-settlement admin routes call the connector's
`pushViaMapping` **directly** (`src/lib/emit-ws-event.ts` → `syncWsToErpnext`),
i.e. the exact transform+signed-POST+log path the subscriber uses, invoked
synchronously. Errors are swallowed/logged so a slow ERPNext never fails the
Medusa-side write. Inbound (ERPNext→Medusa) was always fine — it never used
Medusa events.

## Notes / decisions confirmed during the build
- Runs in **production mode** (`medusa build` + `medusa start`), not
  `medusa develop` — deterministic module loading.
- Medusync Mapping `direction` Select value for two-way is **`Two-way`** (the
  plan's guess "Both" was invalid).
- ERPNext **cannot hard-delete** a settlement once a Medusync Log links to it
  (`LinkExistsError`) — which usefully enforces the "never destroy" rule. The
  ERPNext-side cancel is therefore a status change to `Cancelled`, not a delete.
- Amounts kept in rupees both sides (no paise transform) — verified exact
  (7777, 3000, 2000 …).
- `Cancelled` added to the ERPNext status via a **Property Setter** (no edit to
  the app-owned doctype).

## Left in place (demo)
- Test rows `E2E-M2E-6` (Cancelled) and `E2E-E2M-1` (Cancelled) on both sides as
  evidence; safe to delete from Medusa (which cascades a Cancelled to ERPNext)
  or leave.
- Not committed to any repo (awaiting go-ahead). Frappe-side edits (`mapped.py`
  patch, Property Setter, Medusync Mapping) live only in the demo bench.
