# Phase 3 — stock and prices, ERPNext → Medusa (proposal, 2026-09-26)

**Status:** decided by the user on 2026-09-26 (sellable = actual − reserved − safety; prices
ERPNext → Medusa only; one warehouse per store) and built on `feat/stock-and-prices`
(commit `b40ecb6` and after). See CHANGELOG 0.4.0.

## What medusync did (`handlers/commerce/inventory.py`, `pricing.py`), kept as the rule

- **Stock is ERPNext's.** A store may sell `actual_qty − reserved_qty − safety`, never
  negative, per warehouse. Triggers: a Stock Ledger Entry (receipt/issue) and a Sales Order
  submit/cancel (reserved qty moves with no ledger entry). The level was read from the settled
  Bin after commit, not from the entry.
- **Which warehouse feeds which store** was a table on the site: warehouse → Medusa stock
  location id. An unmapped warehouse was ignored before any work.
- **Price is ERPNext's.** An Item Price on a mapped price list became the variant's price;
  which Price List feeds which store was a table; a cost list could be "Don't Sync".
  MOQ (`min_order_qty`) became variant metadata. MRP: settled as "nowhere" (2026-09-07).

## How it maps onto the Phase 1 machinery

- **Selection**: only Items on ERPNext → Medusa or Both (the `medusa_sync` field) move stock
  or prices; the link table gives the variant.
- **Webhooks (Set up ERPNext adds them):**
  - `Stock Ledger Entry` `after_insert`, condition `doc.warehouse in (<mapped warehouses>)`,
    body `{event, doctype, name, doc: {item_code, warehouse}}`;
  - `Sales Order` `on_submit` and `on_cancel` with the same item/warehouse pairs from `items`;
  - `Item Price` `on_update` and `on_trash`, condition `doc.price_list in (<mapped lists>)`.
- **Plugin side**: the inbound route already verifies and dedupes; a `stock` planner reads the
  Bin over REST (`/api/resource/Bin`, fields actual/reserved/projected) and writes the Medusa
  inventory level at the mapped stock location; a `price` planner writes the variant's price
  in the mapped Medusa price list / currency. Both are echo-safe (Medusa never writes back).
- **Settings**: two small maps — warehouse → stock location, Price List → Medusa price list
  (region/currency) — with "Don't sync" as the absence of a row. Safety stock: one number,
  or the Item's `safety_stock` field when present.
- **Reconciliation** (hourly job): re-read the Bin for every linked variant with a mapped
  warehouse, and Item Prices for mapped lists, to catch missed deliveries.

## Questions

1. **Stock**: sellable = actual − reserved − safety (medusync's rule), or projected_qty
   (ERPNext's own "available for sale", which also counts incoming purchase orders)?
2. **Prices**: ERPNext → Medusa only (medusync's rule), or also Medusa → ERPNext as an Item
   Price on the selling list (which "Auto Insert Item Price If Missing" already does for a
   Sales Order)? The open questions Q1–Q3 in `00-QUESTIONS-ANSWER-THESE-FIRST.md` are the
   inbound-price ones.
3. **Warehouses**: one warehouse per store for now (a setting), or the full table?

## Local e2e, 2026-09-26 night (fixerp + Splendx worktree, plugin 0.3.0-dev9)

Set up ERPNext created the five Webhooks (Stock Ledger Entry after_insert at "Stores - FIPL",
Sales Order on_submit / on_cancel, Item Price on_update / on_trash on "Standard Selling").
Refresh now wrote level 0 for "STANDARD PANEL WORK" (Both) at the Bengaluru stock location,
creating the inventory item and its link that the pull had never made; "AMF PANEL - BUSBAR"
(Medusa → ERPNext) was left alone; "ELE-CAB-…" was skipped with "no variant for Item" (its
Phase 1 product has no variant). A new Item Price (2,500 INR) on fixerp became the variant's
price through the webhook (price set created and linked), 2,500 → 2,600 followed, a Material
Receipt of 1 Nos (MAT-STE-00002, submitted then cancelled) moved the level 0 → 1 → 0 through
the Stock Ledger Entry webhook. **Not exercised: `Item Price on_trash`.** The API user may not
delete an Item Price on fixerp (PermissionError), and Administrator cannot either: the still
installed medusync app linked the test price to a "Medusync Log" row on creation, and Frappe
refuses to delete a linked document. That is a Phase 4 matter (medusync is still running its
handlers on fixerp); the removal path is covered by unit tests only.

Left on fixerp: Item Price `gnfu5f007t` (STANDARD PANEL WORK, Standard Selling, 2,600 INR) and
its Medusync Log row; the cancelled Stock Entry MAT-STE-00002; the five Webhooks. The clone
keeps the inventory item/level and the price set for "STANDARD PANEL WORK".
