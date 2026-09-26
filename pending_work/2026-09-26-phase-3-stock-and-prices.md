# Phase 3 — stock and prices, ERPNext → Medusa (proposal, 2026-09-26)

**Status:** proposed, not built. Needs the user's answer to the questions at the end
before any code (checkpoint 1 of this phase).

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
