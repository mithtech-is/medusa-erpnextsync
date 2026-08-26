# Critical Commerce-Correctness fixes — design

**Date:** 2026-08-26. Remediates the 3 CRITICAL findings from `INTEGRATION_AUDIT_REPORT.md`.
Demo sandbox + medusync only; RISITEX repo untouched. Build & verify one fix at a time.

## Fix 1 — Available qty (ERPNext is the single reservation authority)
**Problem:** inventory push sets Medusa `stocked_quantity = Bin.actual_qty`; reserved/safety never subtracted → overselling. Reservation changes also don't trigger a sync (they don't create an SLE).
**Design:**
- medusync `handlers/risitex/inventory.py::push_level` computes
  `sellable = max(0, actual_qty − reserved_qty − safety_stock)` where
  `actual_qty`/`reserved_qty` come from `Bin(item_code, source_warehouse)` and
  `safety_stock` from the `Item`. Pushes `sellable` as `quantity`.
- **New trigger:** add a `Sales Order` hook (`on_submit`, `on_cancel`,
  `on_update_after_submit`) → for each line item at the source warehouse,
  enqueue `push_level` (reservations change `reserved_qty` with no SLE). Reuse
  the same after-commit enqueue.
- Medusa `_handleInventoryLevelSet` unchanged (receives the number).
**Success:** ERP actual100/reserved20/safety10 → Medusa shows **70**; submit a SO
reserving 10 → Medusa drops by 10; cancel → restored. Single order never
subtracted twice on the ERPNext side.
**Documented residual:** Medusa's own order reservation during the
checkout→SO-sync window is not neutralised here (deeper inventory-strategy change).

## Fix 2 — ERPNext product → real variant + SKU, published
**Problem:** Item→product creates a product-level, **draft**, **0-variant** record →
no SKU → inventory can't match, product unsellable.
**Design:** in the product entity `upsertByKey` (plugin `registry.ts`) /
inbound apply, on create build a Medusa **simple product**: one option
(`"Default"`), one **variant with `sku = item_code`**, and `status = "published"`.
On update: ensure a variant with that sku exists and status is published (don't
clobber a manually-added variant set).
**Success:** create Item `AUDIT-VAR-1` in ERPNext → Medusa product is
**published** with a variant whose sku = `AUDIT-VAR-1`; a subsequent inventory
push for that sku lands (not skipped).

## Fix 3 — Order financials on the Sales Order
**Problem:** SO carries line items + total only; no address/tax/discount/shipping/
payment → not invoice-ready; totals can't be compared.
**Design:**
- Plugin `augmentSalesDocPayload` (index.ts) adds, from the Medusa order:
  `billing_address`, `shipping_address` (address_1/2, city, province,
  postal_code, country_code, phone), `tax_total`, `discount_total`,
  `shipping_total`, `grand_total` (rupees), `payment_method`,
  `payment_reference`.
- medusync `mapped.py` Sales-Order path applies them:
  - create/find ERPNext **Address** docs from the order addresses, link
    `customer_address` + `shipping_address_name` (+ create a linked Contact if
    needed for `contact_email`).
  - add **tax** and **shipping** as `Sales Taxes and Charges` rows
    (`charge_type = "Actual"`, an account head — use company default tax account
    / a `Medusa Charges - <abbr>` account, created if missing) so `grand_total`
    includes them.
  - set `discount_amount` (order-level) so `grand_total` matches.
  - set custom fields `medusa_payment_method`, `medusa_payment_reference`
    (added via Custom Field, like the wallet fields).
**Success:** place/replay a Medusa order → ERPNext SO has both addresses, tax +
shipping charge rows, discount, payment ref, and **`grand_total` == Medusa order
total exactly**.

## Non-goals (this batch)
Multi-size variant sync (one Item = one variant here), pricing/MRP sync, B2B
rules, fulfilment/invoice/returns/refunds (later batches), neutralising Medusa's
own reservations. Money-unit contract stays as-is (verified correct outbound).
