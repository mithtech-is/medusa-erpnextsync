# ERPNext ↔ Medusa Integration — Re-Audit (post-remediation)

**Date:** 2026-08-26. Re-run of `INTEGRATION_AUDIT_REPORT.md` after the
remediation batches. Verified against **live state in both systems** (not just
200s). Test records: AUDIT-*/audit-var-1/E2E-*/order_01KVDCBKZAHJF6ABH3DGCRA00B.

## Live snapshot (current state, both systems)
- **Product** `audit-var-1`: status **published**, variant `sku=audit-var-1`,
  price **79900 paise (₹799)**, `metadata.moq=12`.
- **Order** metadata: `erp_fulfillment`, `tracking` (Delivered), `invoice`
  (Unpaid), `return` (received), `refund` (Credited) — all present.
- **Inventory** sellable: audit-var-1 = 40, PIX-WIB-M = 90 (= actual − reserved − safety).
- **Customer** in group `Commercial`.

## Per-category — before → after

| # | Category | Before | After | Evidence |
|---|---|---|---|---|
| 1 | Product sync | FAIL (draft, 0 variants, no SKU) | **PASS (core)** — published + variant + SKU + name; rich attrs (colour/size/barcode/UOM/brand/HSN/category) still not synced | Fix 2 |
| 2 | Pricing | NOT IMPL | **PASS (core)** — Item Price → variant price, ERPNext wins, no stale; MRP/wholesale/dealer/tiers not | Pricing P1 |
| 3 | MOQ / pack | NOT IMPL | **PASS (MOQ)** — min_order_qty → metadata; pack-size needs a field | Pricing P2 |
| 4 | Inventory (available) | **FAIL** (raw actual) | **PASS** — sellable = actual − reserved − safety (70 case) | Fix 1 |
| 5 | Warehouse mapping | PARTIAL | **PARTIAL** — single source warehouse; non-source ignored (verified); no multi-warehouse table | Inventory |
| 6 | Customer (M→E) | PARTIAL | **PARTIAL** — name/email/phone/group; address & GSTIN still not synced | Pricing P3 |
| 7 | B2B | NOT IMPL | **PARTIAL** — customer group synced; per-group price list / territory / tax category not | Pricing P3 |
| 8 | Checkout + Order | FAIL (no addr/tax/disc/ship/pay) | **PASS** — addresses, tax, discount, shipping, payment ref; grand_total reconciles exactly | Fix 3 + order fetch |
| 9 | ID / Idempotency | PASS (caveat) | **PASS** — + retry now direction- & mapping-aware | Housekeeping |
| 10 | Stock reservation | **NOT IMPL** (double-count risk) | **PASS** — ERPNext single authority; reserved subtracted; SO reserve/cancel re-syncs | Fix 1 |
| 11 | Fulfilment (E→M) | NOT IMPL | **PASS** — Delivery Note → fulfilment; Shipment → AWB/carrier/tracking/delivered (order metadata) | Reverse path |
| 12 | Invoice (E→M) | NOT IMPL | **PASS** — Sales Invoice → number/date/total/status; no accounting internals | Reverse path |
| 13 | Cancellation | PARTIAL | **PASS (core)** — DN cancel → cancelled; reserved released → sellable restored | Fix 1 + reverse |
| 14 | Returns | NOT IMPL | **PASS (E→M) + core (M→E)** — return DN → order.returned + **receipt-gated stock restore** (no double-count); Medusa request → **draft** return DN (gate). Last-mile: Medusa return-event → trigger not wired | Returns A/B |
| 15 | Refund | NOT IMPL | **PASS (record-only)** — Credit Note → order.refunded; integration moves no money (by design) | Returns A |
| 16 | Failure testing | PARTIAL | **PASS** — bad-sig 401, stale-ts 401, unknown-sku skip, dup no-duplicate, retry replays mapped rows through the mapping (Defect A) & never mis-routes inbound (Defect B) | Housekeeping |
| 17 | Security | PASS | **PASS** — HMAC, replay window, masked secrets, 0 secrets in logs | (unchanged) |
| 18 | Reconciliation | PARTIAL (customer-only) | **PARTIAL** — still customer-only, count-based | (unchanged) |

## Issue register — now

### CRITICAL — **all resolved**
Overselling (#4/#10), unsellable ERPNext products (#1), missing order financials
(#8) — fixed and verified.

### HIGH — mostly resolved
Fulfilment/invoice/returns/refunds (#11–15) built; retry-replay defects (#16)
fixed; duplicate customer mappings removed. **Remaining HIGH:** advanced/B2B
pricing depth — MRP, wholesale/dealer price lists, quantity tiers, per-group
price lists (#2/#7) are not synced (need ERPNext price lists / Pricing Rules
seeded first).

### MEDIUM
- Rich product attributes (colour/size/barcode/UOM/brand/HSN/category) not synced (#1).
- Customer **address + GSTIN** not synced outbound (#6); territory / tax category not (#7).
- Reconciliation is customer-only, count-based (#18).
- Return **request** last-mile: Medusa return-event → `create_pending_return`
  trigger not wired (the ERPNext-side draft-return logic is done) (#14).
- Money-unit contract (paise) verified in every path exercised, but not pinned
  by an automated test.

### LOW
Single-warehouse only (#5); ERPNext products publish on sync (acceptable);
TLS/secure-cookie off for local HTTP (flip for prod).

## Verdict

**Before:** SAFE FOR PRODUCTION = NO — the commerce lifecycle was largely unbuilt.

**Now:** the **core order-to-cash + returns loop is functional and verified**
end-to-end: catalogue (published + priced + MOQ), sellable inventory without
overselling, orders with full financials that reconcile, fulfilment/tracking,
invoice, returns with receipt-gated stock restore, refund records, and a
hardened transport (auth/replay/idempotency/retry).

**SAFE FOR PRODUCTION: CONDITIONAL** — ready for the **core B2B flow** with these
named, non-CRITICAL gaps to close first: advanced/B2B pricing depth (MRP,
wholesale/dealer/tier, per-group price lists), rich product attributes, customer
address/GSTIN, reconciliation breadth, and the Medusa-initiated return-request
trigger. No CRITICAL blockers remain.
