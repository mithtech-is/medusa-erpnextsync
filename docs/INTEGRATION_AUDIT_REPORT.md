# ERPNext ↔ Medusa Integration — End-to-End Audit

**Date:** 2026-08-26  **Scope:** demo stack (Medusa `:9000`, Frappe `site1.local`, medusync connector). **No production data touched** — used AUDIT-*/E2E-* test records.
**Method:** validated the *actual final state in both systems* for every implemented path; features with no mapping/handler are marked NOT IMPLEMENTED with evidence (a `200` was never taken as proof).

## What actually exists (authoritative — from live mapping config)

**Enabled sync paths:**
| Mapping | Entity → Doctype | Dir | Fields |
|---|---|---|---|
| Product ↔ Item | product → Item | both | 4 (item_code↔handle, item_name↔title, description[push-only], medusa_product_id) |
| Customer ↔ Customer | customer → Customer | both | 4 (email, first_name, phone, medusa_customer_id) |
| Order → Sales Order | order → Sales Order | push | 2 mapped + augmented line-items/customer |
| Wallet Settlement ↔ RISITEX Wallet Settlement | both | 9 |
| Inventory (SLE hook, not a mapping) | ERPNext Bin → Medusa level | pull | actual_qty only |

**Scaffolded but DISABLED (present, not active, unverified):** Delivery Note → Fulfillment (pull), Order → Sales Invoice (push), Inventory Item ← Bin (pull), Product Variant ↔ Item (push).
**Broken leftovers:** `product variant → Item Variant` (0 fields); duplicate `Customers ↔ ERPNext` customer mappings (×3 enabled) — double-push risk; `Wallet Settlement → …` on non-existent `wallet_transaction` entity.
**Frappe→Medusa outbound doctypes:** Customer, Item, Wallet Settlement, + Stock Ledger Entry (inventory). Nothing else pushes back.

---

## Per-test results

### 1. Product Sync (ERPNext → Medusa)
Created `AUDIT-ITEM-1` (item_name, description, weight_per_unit) in ERPNext → Medusa product `audit-item-1`.
| Field | Verdict | Actual |
|---|---|---|
| name (item_name→title) | PASS | "Audit Test Tee" |
| description | **FAIL** | empty in Medusa (mapping is push-only Medusa→ERPNext) |
| SKU | **FAIL** | product created with **0 variants → no SKU/inventory item** |
| variants / colour / size | **NOT IMPLEMENTED** | product-level only; no variant sync |
| barcode / UOM / brand / category / HSN / weight | **NOT IMPLEMENTED** | not in the 4-field mapping |
| status | **WARNING** | product created as **draft** (never published → invisible on storefront) |
- create: PARTIAL (title+handle only) · update: PARTIAL · disable/re-enable: NOT TESTED (no `disabled↔status` mapping — NOT IMPLEMENTED) · variant add/update: NOT IMPLEMENTED · duplicate event: PASS (upsert by item_code, no dup — see #9)

### 2. Pricing Sync — **NOT IMPLEMENTED**
No price mapping exists. MRP / retail / wholesale / dealer / quantity-tier / currency / validity are **not synced** from ERPNext. "ERPNext price always wins / no stale price" — NOT TESTABLE (no pipe). Medusa prices are set independently.

### 3. MOQ / Pack Size — **NOT IMPLEMENTED (as a sync)**
MOQ/pack are **not** in the Product↔Item mapping; not pushed from ERPNext. MOQ/pack enforcement exists **storefront-side** (Medusa metadata, separate feature) but is not ERPNext-driven. Accept/reject of 24/36/48 vs 12/25/30 is a storefront concern, NOT TESTABLE via this integration.

### 4. Inventory — **PARTIAL / FAIL on the core rule**
- Set ERPNext actual = 100 → Medusa `stocked_quantity` = **actual_qty verbatim**.
- `available = actual − reserved − safety` (expected 70): **FAIL — NOT IMPLEMENTED.** The handler (`_handleInventoryLevelSet`) sets `stocked_quantity = Bin.actual_qty`; **reserved_qty and safety stock are never read/subtracted.** Medusa then subtracts only its *own* reservations.
- stock increase / decrease / zero: **PASS** (verified 50→10→0 in both systems).
- ERPNext-originated item stock: **FAIL** — `AUDIT-ITEM-1` level = None (product has no variant SKU, so the inventory push finds no `inventory_item` and skips). Inventory only works for SKUs already present in Medusa.
- negative/invalid stock, warehouse disabled: NOT TESTED (edge handling unverified).

### 5. Warehouse Mapping — **PARTIAL**
Single source warehouse (`Finished Goods - R`, a setting) → the single Medusa stock location. There is **no warehouse→location mapping table**; multi-warehouse is out. Non-source warehouse movements are correctly ignored (verified: a Stores-R move left Medusa unchanged). PASS for single-location; NOT IMPLEMENTED for real multi-warehouse mapping.

### 6. Customer (Medusa → ERPNext) — **PARTIAL**
Verified earlier this session: name, email, phone sync; `medusa_customer_id` link stored. **Address (billing/shipping) and GSTIN: NOT IMPLEMENTED** (not in the 4-field mapping). Existing-customer matching: PASS (upsert by email). Duplicate prevention: PASS (email key) — **but three enabled duplicate customer mappings exist → the same event pushes multiple times (WARNING, wasteful, not corrupting).**

### 7. B2B Customer — **NOT IMPLEMENTED**
Customer group / price list / territory / tax category / B2B status are **not synced** in either direction. B2B pricing exists as a separate Medusa module, not fed by ERPNext.

### 8. Checkout + Order (Medusa → ERPNext Sales Order) — **PARTIAL**
Inspected `SAL-ORD-2026-00015` (medusa_order_id `e2e_so_...`):
| Field | Verdict |
|---|---|
| Medusa Order ID | PASS (stored) |
| Customer, contact_email | PASS |
| SKU / qty / rate / amount / warehouse (line items) | PASS |
| Grand Total / Net Total | PASS (1497 matches) |
| Addresses (billing/shipping) | **FAIL — not on SO** |
| Tax | **FAIL — total_taxes_and_charges = 0, 0 tax rows** |
| Discount | **FAIL — discount_amount = 0** |
| Shipping | **NOT IMPLEMENTED** |
| MRP | **NOT IMPLEMENTED** |
| Payment method / reference | **NOT IMPLEMENTED** |
Full checkout (cart→MOQ→pricing→discount→tax→shipping→payment→order) as an integrated flow: NOT TESTABLE end-to-end (pricing/tax/discount/shipping not synced). Also found **orphan `SAL-ORD-00014` with null medusa_order_id** (residue of a past duplicate-SO bug).

### 9. ID Mapping / Idempotency — **PASS (with caveat)**
- Medusa Order ID stored in ERPNext (`medusa_order_id`) ✓; ERPNext ids stored in Medusa (`medusa_*_id`) ✓.
- Replayed the **same `event_id` twice** → receiver re-processes (returns success both times, **no short-circuit on event_id**) BUT handlers upsert by natural key → **no duplicate records** (verified). So "1 record not 2" holds for customer/item/inventory/wallet.
- Orders: previously produced duplicate Sales Orders (key not stamped) — **fixed** (stamp `medusa_order_id` on insert); the orphan 00014 is old residue. Payments/Shipments/Returns/Refunds idempotency: NOT TESTABLE (not implemented).

### 10. Stock Reservation — **NOT IMPLEMENTED**
No reservation sync. Medusa reserves its own; ERPNext reserves its own; they are **not linked to the same physical stock**. The `50−10−10=30` double-reserve risk is **real and unmitigated** once both sides act on the same SKU (compounded by #4 — reserved isn't even subtracted in the level push).

### 11. Fulfilment (ERPNext → Medusa) — **NOT IMPLEMENTED (scaffolded, disabled)**
`Delivery Note → Fulfillment` mapping exists but is **DISABLED**, and there is no active inbound handler wiring fulfilled qty / shipment status / courier / AWB / tracking number / tracking URL / dispatch date into Medusa. None of these flow today.

### 12. Invoice (ERPNext → Medusa) — **NOT IMPLEMENTED (scaffolded, disabled)**
`Order → Sales Invoice` mapping exists but is **DISABLED** and is push-direction (Medusa→ERPNext), not ERPNext→Medusa. Invoice number/date/tax/total/status do **not** reach Medusa.

### 13. Cancellation — **PARTIAL**
`order.canceled` is in the Order mapping's events (push). Cancel-before-fulfilment can propagate an order-cancel to ERPNext, but **reservation release / stock correction / refund handling are NOT IMPLEMENTED** (no reservation or refund pipe). Cancel-after-packing/after-invoice: NOT TESTABLE (no fulfilment/invoice sync).

### 14. Returns — **NOT IMPLEMENTED**
No return mapping/handler on either side. "Do not restore stock until ERPNext confirms receipt" — moot; nothing implemented.

### 15. Refund — **NOT IMPLEMENTED**
No refund sync. refund id / payment id / amount / reason / date / status / credit note: none.

### 16. Failure Testing — **PARTIAL (auth & replay solid; recovery partial)**
| Case | Verdict |
|---|---|
| Bad signature | **PASS** → 401 before any work |
| Stale/missing timestamp (replay) | **PASS** → 401 (±300 s window) |
| Invalid SKU | **PASS** → 200 `{skipped, "no inventory item"}`, no crash |
| Duplicate webhook | **PASS** → no duplicate record (upsert) |
| ERPNext/Medusa unavailable, timeout, 500 | PARTIAL — an `erpnext_sync_event` log + retry route + reconciliation cron exist (drift detected in logs), but full outage-recovery/replay was not exercised here |
| Out-of-order webhook, partial sync | NOT TESTED |
| 401/403 upstream, network interruption | NOT TESTED |
Failed events are logged (Medusync Log + erpnext_sync_event) and replayable via the retry path — mechanism present, not exhaustively verified.

### 17. Security — **PASS (mostly)**
| Check | Verdict |
|---|---|
| Webhooks authenticated (HMAC-SHA256, constant-time) | PASS |
| Replay protection (signed `ts`, ±300 s) | PASS |
| Secrets in logs | PASS — **0 of 200 log rows** contained a secret |
| Secret storage | PASS — masked `Password` fields (`inbound_secret`, `outbound_secret`) |
| No secrets in webhook payloads / URLs | PASS (HMAC header only) |
| Admin endpoints protected | PASS (bearer/session; login now cookie-fixed) |
| No card/CVV stored | NOT TESTABLE here (no payment capture in this demo path) |
| API keys in frontend | NOT AUDITED (storefront out of this pass) |

### 18. Reconciliation — **PARTIAL**
A reconciliation cron runs and **detects drift** (observed `reconciliation.drift frappe=78 medusa=0`) for customer mappings — i.e. it *reports* mismatch but the two sides are materially out of sync for anything beyond the enabled entities. Products/variants/SKUs/prices/stock/orders/payments/shipments/returns/refunds are **not reconciled** because most aren't synced.

---

## Issue register

### CRITICAL
1. **Stock reservation not linked (double-deduction risk).** #10/#4 — reserved qty is neither synced nor subtracted; Medusa and ERPNext can each reserve the same physical unit. *Fix:* push `projected_qty`/`actual−reserved−safety` (or reserve on the ERPNext side from the Medusa order) instead of raw `actual_qty`. **Risk: HIGH — overselling.**
2. **ERPNext products create no SKU/variant in Medusa** → inventory push can't match them, products land as **draft** (unsellable). #1/#4. *Fix:* create a variant with `sku = item_code` (or a real variant model) on product inbound, and publish. **Risk: HIGH — catalogue & stock unusable for ERPNext-origin items.**
3. **Order financials incomplete** — no addresses, tax, discount, shipping, payment reference on the Sales Order. #8. *Fix:* augment the order push (already sends line items) with billing/shipping address, tax lines, discount, shipping, payment method/ref. **Risk: HIGH — ERPNext orders are not invoice-ready.**

### HIGH
4. Fulfilment, Invoice, Returns, Refunds, Cancellation-side-effects **not implemented** (#11–15) — the entire post-order reverse path is missing. **Risk: HIGH — no dispatch/tracking/refund visibility in the store.**
5. Pricing & B2B commercial rules not synced (#2, #7) — Medusa prices can drift from ERPNext with no guard. **Risk: HIGH for a B2B catalogue.**
6. **Retry does not faithfully replay a failed *mapped* push (recovery defect).** `retryEvent` (`index.ts:1508`) replays via the legacy full-payload `forwardEvent` → the wrong Frappe method (`receive`, not `receive_mapped`) with **no field transform and no `augmentSalesDocPayload`**. A failed Sales-Order/customer *mapped* push will **not** reproduce the original write on retry — directly violates "failed sync can recover safely." Plus `retryEvent`'s lookup has **no `direction` filter** (`index.ts:1509`) so an inbound row can be replayed outbound. **Risk: HIGH — silent wrong-state on recovery.**
7. **Duplicate enabled customer mappings (×3)** and a 0-field `product variant` mapping — double-pushes + a broken mapping. *Fix:* delete the duplicates/leftovers. **Risk: MEDIUM.**

### MEDIUM
7. Inbound receiver does not short-circuit on seen `event_id` (re-processes) — safe today only because handlers are upsert-by-key; any future non-idempotent handler would double-apply. #9. **Risk: MEDIUM.**
8. Description (and most product fields) sync push-only / not at all; ERPNext is not the catalogue source of truth it's assumed to be. #1. **Risk: MEDIUM.**
9. Orphan `SAL-ORD-00014` (null medusa_order_id) from a past duplicate bug — clean up; confirm the fix holds under retry. **Risk: MEDIUM.**

### LOW
10. Products created as `draft` require manual publish. 11. Single-warehouse only (no mapping table). 12. **Reconciliation is customer-only** — the drift/count compare returns non-null only for the `customer` entity (`countMappingRows`, `index.ts:2517`); products/orders/inventory are never reconciled, and it compares row *counts*/email-set membership, not field content. 13. Signature-mismatch diagnostic logs a **16-char prefix of the expected signature** (`index.ts:367`) — a partial derived-value leak (not the secret). 14. TLS not yet in front (secure-cookie disabled for local HTTP — flip on for prod).

### Deep code-audit corroboration + extra findings
- **Only ONE mapping ships by default: `Customer ↔ Customer` (3 fields).** The Product↔Item and Order→Sales Order mappings active in *this* demo are **operator-seeded rows**, not shipped defaults — a fresh install syncs customers only. Everything else (product fields, pricing, inventory, fulfilment, order financials) is **pickable scaffolding** in the admin field-mapper, not implemented sync.
- **Money-unit contradiction (verify against the running build).** The outbound Sales-Order builder divides `unit_price` by 100 (paise assumption, `index.ts:73`) while the inbound `order.placed` handler writes `rate` in rupees directly (`index.ts:1315`). In *this* build the outbound path is correct (verified SO grand_total 1497 = 3×499), so the **inbound** assumption is the latent one; if a future build changes money units the `/100` becomes a **100× billing error**. Flag: pin the money-unit contract and add a unit test both directions.
- **`dispatchInbound` handles exactly:** ping, inventory.level.set, customer.created/updated, order.placed/canceled, wallet.*, share.sale.*, security.updated — everything else → `{skipped, no_handler_for_event}`. Confirms fulfilment/invoice/return/refund have **no inbound handler**.

---

## Verdict

**SAFE FOR PRODUCTION: NO.**

What is solid: the **transport** (HMAC auth, replay window, idempotent upserts, secret hygiene, logging/retry scaffolding) and a handful of **forward syncs** (customer name/email/phone, product name, order line items, wallet settlements, one-way stock level for pre-existing SKUs).

What blocks production: the **commerce lifecycle is largely unbuilt** — pricing, MOQ-from-ERP, variants/SKUs on ERP-origin products, reserved/safety-stock availability, order tax/discount/shipping/address/payment, fulfilment/tracking, invoice, cancellation side-effects, returns and refunds are **NOT IMPLEMENTED**, and stock reservation is unlinked (overselling risk). The integration today is a **partial master-data sync**, not an end-to-end order-to-cash pipeline.
