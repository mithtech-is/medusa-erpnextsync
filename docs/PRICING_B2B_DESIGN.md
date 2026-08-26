# Pricing + B2B (Core) — design

**Date:** 2026-08-26. Remediates audit #2 (pricing), #3 (MOQ), #7 (B2B group).
ERPNext → Medusa; ERPNext price always wins. Demo sandbox + medusync only.

## P1 — Item Price → Medusa variant price
- medusync `handlers/risitex/pricing.py::on_item_price` (hooked `Item Price`
  after_insert / on_update / on_trash). Only the selling price list
  (`Standard Selling`, overridable via a `pricing_selling_price_list` setting).
  Push `variant.price.set {sku: item_code, amount: price_list_rate, currency,
  valid_from, valid_upto, deleted: (on_trash)}`.
- Plugin `dispatchInbound` case `variant.price.set` → resolve the variant by
  `sku` (product module) → set/overwrite its price for `currency` via the
  pricing module (the variant's price set). If `deleted` or not currently
  within [valid_from, valid_upto], remove/skip. ERPNext overwrites → no stale,
  no duplicate.

## P2 — MOQ → variant metadata
- medusync `on_item` (hooked `Item` on_update) → push `variant.meta.set
  {sku: item_code, moq: min_order_qty}`.
- Plugin case `variant.meta.set` → merge `variant.metadata.moq` (product module
  `updateProductVariants`). The storefront reads MOQ from variant metadata.

## P3 — Customer Group → Medusa (B2B)
- medusync `on_customer_group_link` (hooked `Customer` after_insert/on_update) →
  push `customer.group.set {medusa_customer_id, email, group: customer_group}`.
- Plugin case `customer.group.set` → resolve the Medusa customer by
  `medusa_customer_id` or email; ensure a Medusa customer group named `group`
  exists (create if missing); add the customer to it (idempotent).
- Per-group price list is a follow-up (needs a wholesale ERPNext price list +
  `Customer Group.default_price_list`; neither exists yet).

## Common / safety
- Delivered via the existing signed `outbound.deliver` pipe + Medusync Log;
  plugin reuses `/webhooks/erpnext-inbound` HMAC/ts/idempotency.
- Loop guard: `frappe.flags.medusync_inbound` (inbound writes don't re-push).
- Validity: a price with `valid_upto` in the past → treated as no price
  (skip/remove) so the storefront never shows an expired rate.

## Non-goals (this batch)
MRP / pack-size (need new Item custom fields), wholesale/dealer price lists +
qty-tier Pricing Rules (need seeding), territory/tax-category sync.
