# Inventory (stock-level) sync — E2E results

**Date:** 2026-08-26. Built per `INVENTORY_SYNC_PLAN.md`, verified live on the demo
stack (Medusa prod `:9000`, Frappe `site1.local`).

## PASS matrix (all green)

| # | Check | Result |
|---|---|---|
| 1 | Set stock in ERPNext (Finished Goods - R) → Medusa level | ✅ PIX-WIB-S/M/L → 50/15/8, then 10/15/8 |
| 2 | Change stock → Medusa follows | ✅ PIX-WIB-S 50→10→**0** |
| 3 | Movement in a **non-source** warehouse (Stores - R) | ✅ ignored — Medusa PIX-WIB-M stayed 15 |
| 4 | Unknown SKU push | ✅ 200 `{skipped, "no inventory item for sku"}` |
| 5 | Bad signature | ✅ 401 |
| 6 | Regression: Customer create Medusa→ERPNext | ✅ synced |
| 7 | Regression: Wallet Settlement create Medusa→ERPNext | ✅ synced (INV-REG-2, medusa_settlement_id linked) |

## The key bug found & fixed during the build

**SLE timing.** At `Stock Ledger Entry.after_insert`, **neither `Bin.actual_qty`
NOR the SLE's own `qty_after_transaction` is finalised** — ERPNext posts the
ledger and updates the Bin *after* the hook fires. The first attempts pushed
`quantity: 0.0` for every movement. **Fix:** `on_sle` only DECIDES relevance
(warehouse filter), then enqueues an **after-commit job** (`push_level`,
`enqueue_after_commit=True`) that reads the now-correct `Bin.actual_qty` and
delivers. Verified: a 50-unit set then pushes `50.0` and Medusa shows 50.

## Operational fix (demo bench)

The Frappe bench kept dying seconds after boot: `schedule.1` (the scheduler)
exits rc=0 on this site and honcho's "one process exits → stop all" tore the
whole bench down. **Fix:** commented `schedule: bench schedule` in the Procfile
(the sync needs the **worker**, not the scheduler — the after-commit job runs on
`bench worker`). Bench now stays up.

## What was built (demo plugin + medusync only; RISITEX repo untouched)

- **Plugin** (`modules/erpnext/index.ts`): `case "inventory.level.set"` in
  `dispatchInbound` + `_handleInventoryLevelSet` — resolves `inventory_item` by
  `sku`, the single stock location, and sets `stocked_quantity`. Reuses the
  existing HMAC-verified `/webhooks/erpnext-inbound` (signature + `ts` window +
  `event_id` idempotency + `erpnext_sync_event` logging).
- **medusync** `handlers/risitex/inventory.py` + `hooks.py` — SLE hook → signed
  `inventory.level.set` via the existing `outbound.deliver` pipe.
- **medusync Settings**: `inventory_source_warehouse` Custom Field (default
  Finished Goods - R).
- **Demo seed**: SKU-level stock Items (`PIX-WIB-S/M/L`) + Material Receipts.

## Notes
- One-way (ERPNext→Medusa). Medusa never writes stock back → no loop, no
  double-count from the sync itself.
- Matching key: ERPNext `Item.item_code` == Medusa `inventory_item.sku`.
- Amounts/quantities are plain numbers (no transform).
- Not committed to any repo (awaiting go-ahead). Frappe-side edits live in the
  demo bench.
- Leftover demo state: PIX-WIB-S=0, M=15, L=8 (fine to keep as a demo);
  regression records INV-REG-* can be cleaned.
