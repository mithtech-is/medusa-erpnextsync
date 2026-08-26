# Inventory (stock-level) sync — design

**Date:** 2026-08-25
**Scope:** One-way, real-time, per-SKU stock-level sync **ERPNext → Medusa** in
the generic medusync connector. Demo sandbox only (`risitex-mainb2b` + the
generic plugin). **The real RISITEX repo is not touched.** Queued after the
Wallet Settlement feature (built + verified).

## Goal / success criteria

When stock moves in ERPNext at the sellable warehouse, Medusa's on-hand for the
matching SKU updates within seconds — automatically, no manual step. Verified:

- Post a Stock Reconciliation / receipt for a SKU at **Finished Goods - R** →
  Medusa `InventoryLevel.stocked_quantity` for that SKU updates to match.
- Issue/deliver stock (qty drops) → Medusa level drops to match.
- A movement in a **non-source** warehouse → Medusa is **not** touched.
- Medusa never writes stock back to ERPNext (one-way; no loop).
- Rides the existing HMAC signing + `ts` replay window.

## Decisions (all agreed)

- **Owner:** ERPNext owns stock. Sync is **ERPNext → Medusa only** for
  quantity. Medusa never writes stock to ERPNext.
- **Trigger:** real-time — a `doc_events` hook on **Stock Ledger Entry**
  (`after_insert`), Approach A. SLE is the canonical event for every stock
  movement. The handler reads the item's authoritative **`Bin.actual_qty`** for
  the source warehouse (not the SLE running balance) and pushes it.
- **Source warehouse:** **Finished Goods - R**, stored as a setting
  (`inventory_source_warehouse`) so it can be changed without code.
- **Granularity:** per-SKU. Key = ERPNext **`Item.item_code`** ↔ Medusa
  **`inventory_item.sku`**. Each variant/size has its own on-hand.
- **Medusa target:** the single `stock_location`'s `InventoryLevel`,
  `stocked_quantity` field. (Reserved is Medusa's own; untouched.)
- **No new Medusa admin UI** — stock is read-only in Medusa (ERPNext owns it);
  Medusa's native inventory views already show it.

## What syncs

| Source (ERPNext) | → | Target (Medusa) |
|---|---|---|
| `Bin.actual_qty` for (`item_code`, `Finished Goods - R`) | → | `InventoryLevel.stocked_quantity` for `inventory_item(sku=item_code)` at the stock location |

Nothing else. Not reserved qty, not valuation, not other warehouses.

## Components (each independently testable)

### 1. ERPNext trigger — `medusync/handlers/risitex/inventory.py`
- `on_sle(doc, method)` — bound via a new `doc_events` entry in `hooks.py`:
  `"Stock Ledger Entry": { "after_insert": "medusync.handlers.risitex.inventory.on_sle" }`
  (coexists with the existing wildcard `*` hook — both fire; the wildcard's
  `on_doc_event` finds no mapping for SLE and returns).
- Logic: if sync enabled AND `doc.warehouse == settings.inventory_source_warehouse`,
  read `frappe.db.get_value("Bin", {item_code, warehouse}, "actual_qty")` (0 if
  no Bin), then deliver a signed POST to Medusa
  `POST {medusa_url}/webhooks/erpnext-inventory` with body
  `{ event, event_id, ts, data: { sku: item_code, quantity: actual_qty } }`.
  Reuses `medusync.signing.sign` + `medusync.outbound`'s delivery/log pattern,
  and logs into **Medusync Log** (direction Outbound).
- Must be cheap and never raise (an exception would abort the stock posting).

### 2. Medusa receiver — plugin route `POST /webhooks/erpnext-inventory`
- New route in the generic plugin
  (`src/api/webhooks/erpnext-inventory/route.ts`), HMAC-verified against
  `frappe_to_medusa_secret` with the same constant-time check + `ts` replay
  window + `event_id` idempotency the existing `erpnext-inbound` receiver uses
  (extract the shared verify into a small helper if not already).
- Logic: resolve the inventory item by sku
  (`inventoryService.listInventoryItems({ sku })`); resolve the stock location
  (the single one, or `INVENTORY_LOCATION_ID` env override); then
  `inventoryService.updateInventoryLevels([{ inventory_item_id, location_id,
  stocked_quantity: quantity }])`. If no inventory item matches the sku, log a
  skipped event (no error). Record success/skip in `erpnext_sync_event`.

### 3. Config — Medusync Settings
- Add `inventory_source_warehouse` (Link → Warehouse, default `Finished Goods - R`)
  and reuse the existing enable flag. Surfaced in the settings doctype.

### 4. Demo enablement seed
- `seed-inventory-demo`: for a handful of Medusa SKUs (e.g. the `PIX-*` set),
  ensure a matching **ERPNext stock Item** exists (`item_code = sku`,
  `is_stock_item = 1`, an item group + stock UOM), then post a **Stock
  Reconciliation** at Finished Goods - R setting each to a known qty — which
  fires the SLE hook and flows to Medusa. Idempotent.

## Data flow

Stock movement in ERPNext → SLE `after_insert` → `on_sle` reads
`Bin.actual_qty(item_code, Finished Goods - R)` → signed POST to
`/webhooks/erpnext-inventory` → HMAC verified → resolve `inventory_item(sku)` +
location → `updateInventoryLevels(stocked_quantity)` → Medusa on-hand matches.
Medusa never emits anything back.

## Error handling
- Hook wrapped in try/except + `frappe.log_error`; a failure never blocks the
  stock transaction.
- Receiver: bad signature → 401 before any work; unknown sku → logged skip, 200;
  DB error → generic 500 + server-side log.
- Idempotency via `event_id`; replay window via signed `ts` (both already built).

## Testing (end-to-end, real HMAC)
1. Seed a SKU Item + set qty 25 at Finished Goods → Medusa level for that sku = 25.
2. Reconcile the same sku to 10 → Medusa level = 10.
3. Reconcile to 0 → Medusa level = 0.
4. Move stock in a **different** warehouse → Medusa unchanged.
5. Unknown sku push → logged skip, no crash, Medusa unchanged.
6. Bad signature → 401.
7. Regression: Customer / Item / Wallet-Settlement sync still green.

## Non-goals
- No Medusa → ERPNext stock writes (would need a Stock Reconciliation writer +
  reservation reconciliation — explicitly out).
- No reserved-quantity sync; Medusa manages its own reservations. **Known
  nuance (documented, not a defect):** `stocked_quantity` mirrors ERPNext
  on-hand, and Medusa separately subtracts its reservations for "available"; a
  reservation can be briefly reflected on both sides until ERPNext decrements on
  its Delivery Note. Acceptable under ERPNext-owns-stock.
- No multi-location mapping (single Medusa location); multi-warehouse summing
  was declined in favor of one source warehouse.
- No changes to the existing product-level Product↔Item catalog mapping.
