# medusync ↔ Medusa — remediation change set

Self-contained, PR-ready capture of all connector remediation work
(2026-08-25 → 08-27). Verified live on the demo stack. **Demo sandbox +
medusync only; the real `risitex-mainb2b` app repo is untouched.** Published
here at `mithtech-is/erpnextsync` as the change-set of record.

This is captured as its own folder+git repo because the pieces live in three
places that can't be committed together cleanly: the generic plugin folder is
not a git repo, the medusync Frappe app in the WSL bench has no git, and the
`risitex-mainb2b` sandbox repo carries unrelated pre-existing churn.

## Layout
- `docs/` — every design/spec/results/audit doc:
  - `INTEGRATION_AUDIT_REPORT.md` (the full audit + production verdict)
  - `INTEGRATION_AUDIT_REPORT_V2.md` (post-remediation re-audit; verdict
    CONDITIONAL — no CRITICAL blockers remain)
  - Wallet Settlement: `WALLET_SETTLEMENT_SYNC_{DESIGN,PLAN,RESULTS}.md`
  - Inventory: `INVENTORY_SYNC_{DESIGN,PLAN,RESULTS}.md`
  - Critical fixes: `CRITICAL_FIXES_DESIGN.md`
  - Reverse path: `REVERSE_PATH_DESIGN.md`
  - Returns/Refunds: `RETURNS_REFUNDS_DESIGN.md`
  - Pricing/B2B: `PRICING_B2B_DESIGN.md`
- `src/` — the **full installable Medusa plugin** (`medusa-plugin-erpnext`):
  module service (`modules/erpnext/`), admin API routes (`api/admin/erpnext/`),
  admin UI (`admin/routes/erpnext/`), and cron jobs (`jobs/`). All plugin-side
  changes described below live here in place.
- `backend/` — a Medusa **backend** module used alongside the plugin: the new
  `wallet_settlement` module + its admin API routes, admin page,
  `lib/emit-ws-event.ts`, and seed. (Also modified in place in the backend:
  `medusa-config.ts` — register `wallet_settlement` + `cookieOptions:
  {secure:false, sameSite:"lax"}`; `src/scripts/seed-erpnext-demo.ts` — `const
  cur: any` type fix.)
- **ERPNext side** — the Frappe `medusync` app changes (`inventory.py`,
  `sales_financials.py`, `reverse.py`, `pricing.py`, `address_sync.py`, patched
  `mapped.py`, `hooks.py`, `__init__.py`, and the setup/seed scripts) are
  published separately at **`suparikoli/medusync`**.

## What's included (by feature)

**Wallet Settlement two-way sync** — plugin `wallet_settlement` registry entity;
sandbox module+routes+admin page; `mapped.py` cancel-not-delete; `Cancelled`
status Property Setter; Medusync Mapping seed. (Route→ERPNext push is a direct
`pushViaMapping` call — see `WALLET_SETTLEMENT_SYNC_RESULTS.md` for why events
don't fire from a plain route.)

**Inventory (stock-level) sync** — plugin `inventory.level.set` handler
(auto-creates + links an inventory item when missing); medusync
`handlers/risitex/inventory.py` (SLE + Sales Order hooks → `sellable =
actual − reserved − safety`); `inventory_source_warehouse` setting.

**Critical commerce-correctness fixes**
- Fix 1 overselling: sellable push + Sales-Order reservation trigger.
- Fix 2 product sellable: `registry.ts` product upsert makes a published
  simple product with `variant.sku = handle`; inventory handler creates+links
  the inventory item.
- Fix 3 order financials: `augmentSalesDocPayload` (addresses, tax/discount/
  shipping/grand totals, payment ref) + `sales_financials.py::apply_financials`
  (Address docs, tax+shipping charge rows, discount, payment Custom Fields).
- Order fetch: order `fetchById` rewritten to `query.graph` (+ grand total from
  `summary`, financials derived so grand_total always reconciles).

**Reverse path (ERPNext → Medusa order metadata)** — plugin `order.fulfilled` /
`order.tracking` / `order.invoiced` cases + `_mergeOrderMeta`; medusync
`handlers/risitex/reverse.py` (Delivery Note / Shipment / Sales Invoice hooks).

**Returns & Refunds (both directions)** — plugin `order.returned` /
`order.refunded` cases (→ `_mergeOrderMeta`). `reverse.py` return branches:
return Delivery Note (`is_return`) → `order.returned` with **receipt-gated**
stock restore (no double-count); Credit Note Sales Invoice → `order.refunded`
(record-only — the integration moves no money by design). A Medusa-initiated
return request calls `create_pending_return` → a **draft** return DN awaiting
warehouse receipt. (See `RETURNS_REFUNDS_DESIGN.md`.)

**Pricing & B2B (ERPNext → Medusa; ERPNext price always wins)** — plugin
`variant.price.set` (creates + links a price set on first price, else updates;
expired/deleted → clears), `variant.meta.set` (MOQ), `customer.group.set`
(finds/creates group + adds member, idempotent). medusync
`handlers/risitex/pricing.py`: Item Price (selling list only) → `variant.price.set`;
Item `min_order_qty` → `variant.meta.set`; Customer group link →
`customer.group.set`. Setup: `frappe/pricing_setup.sh`,
`frappe/pricing_patch_hooks.py`. (See `PRICING_B2B_DESIGN.md`.)

**Return-request last-mile (Medusa-initiated → ERPNext draft return DN)** —
closes the one gap the V2 audit named. Medusa admin route
`POST /admin/erpnext/orders/:id/request-return` → plugin module method
`requestReturn(orderId, items)` signs + POSTs event `order.return_requested`
to `medusync.api.receive` (full HMAC + replay + idempotency + Medusync Log).
On the Frappe side a registry handler `reverse.handle_return_requested`
(registered at import time via `medusync/__init__.py` → `handlers.risitex.register`)
elevates to Administrator and calls `create_pending_return` → a **DRAFT**
return Delivery Note (docstatus 0, zero stock impact) awaiting warehouse
receipt; submitting it later fires the reverse path (`order.returned` +
receipt-gated stock restore). Verified live end-to-end: a Medusa
`requestReturn` created draft return DN `MAT-DN-2026-00007` (is_return=1,
qty −1, 0 Stock Ledger Entries), and an over-return returns a clean 200-skip
(not a 5xx) so Medusa never retries a permanent business rejection. Repo
files: `plugin/api/.../orders/[id]/request-return/route.ts`, `requestReturn`
in `plugin/modules/erpnext/index.ts`, `frappe/handlers/reverse.py`,
`frappe/handlers/risitex__init__.py` (= `medusync/handlers/risitex/__init__.py`),
`frappe/medusync_pkg__init__.py` (= `medusync/__init__.py`).

**Customer address + GSTIN (Medusa → ERPNext)** — closes audit gap #6/#7.
On `customer.created`/`customer.updated` + the bulk Push Customers route: GSTIN
→ `Customer.gstin` (rides `_set_fields`, no special-case) and `customer.addresses[]`
→ linked ERPNext `Address` docs. GSTIN lives on the B2B **Company**, resolved via
`customer.metadata.company_id` (11/11 linked customers have it; `applicant_email`
is unreliable). Plugin: `registry.ts` wraps `customerEntity.fetchById` to attach
`gstin`/`company_trade_name`/`company_billing_address` (guarded — no company
module → plain customer); `index.ts` `augmentCustomerPayload` reshapes addresses
into stable-id'd `medusa_addresses[]` (+ the company billing address as a
synthetic `company:<id>` entry). Frappe: new `address_sync.sync_customer_addresses`
(create/update Address via Dynamic Link, idempotent by the `medusa_address_id`
Custom Field, country ISO-2→ERPNext via `Country.code`, stale→**disabled** not
destroyed); `mapped.py` Customer branch pops `medusa_addresses` and calls it after
save. Setup: `frappe/addr_setup.py` (the `medusa_address_id` Custom Field). Verified
live: `cus_01KW9P…` → Customer gstin `27AAACE1234A1Z5` + 2 linked Addresses (own +
company billing), pushed 3× stayed 2 (idempotent), country `in`→`India`, drop→disabled.
Repo files: `plugin/modules/erpnext/{index,registry}.ts`,
`frappe/handlers/{address_sync,mapped}.py`, `frappe/addr_setup.py`,
`docs/CUSTOMER_ADDRESS_GSTIN_DESIGN.md`. Known limitation: standalone address-only
edits sync on the next customer update / bulk push, not instantly (`customer_address.*`
live events not yet wired — event name unconfirmed).

**Reconciliation breadth (Medusa ↔ ERPNext)** — closes audit gap #18
(reconcile was customer-only, count-based, and gated on the empty
`kyc_fully_approved_at` — 0/90 on this site, so it checked nothing). Now a
detail-level reconcile for customer/product/order: matches Medusa `id` ↔ ERPNext
`medusa_*_id` **with a natural-key fallback** (product `handle↔item_code`,
customer `email↔email_id`; order id-only) — without the fallback every
catalogue-pulled product false-reports as missing (dropped ~18→1). Returns
per-entity `matched` / `missing_on_frappe` / `frappe_orphans` (capped id lists +
`truncated`). Plugin: `reconcileMapping` + `reconcileAll` (allowlist
customer/product/order; append-only Stock Ledger Entry → `skipped`); admin route
`GET /admin/erpnext/reconcile`; a **Reconcile** tab (one button + per-entity
table + click-to-expand ids) for non-technical admins; the hourly cron now runs
the detailed reconcile across all entities and writes `reconciliation.drift`
events with capped payloads. Verified live (run twice = identical): customer
52/83 matched=46 missing=6 orphans=15; order 15/19 matched=14 missing=1
orphans=3 (incl. SAL-ORD-2026-00021 whose non-live `PENDING-RET-TEST-1` id makes
it an orphan); product 40/44 matched=39 missing=1. Repo files:
`plugin/modules/erpnext/index.ts`, `plugin/jobs/reconciliation.ts`,
`plugin/admin/routes/erpnext/page.tsx`, `plugin/api/.../reconcile/route.ts`,
`docs/RECONCILIATION_BREADTH_DESIGN.md`.

**Rich product attributes (Medusa metadata → ERPNext Item)** — partially closes
audit gap #1. Four flat `metadata.*` attributes now push to the Item:
`category → item_group` (auto-created), `hsn_code`, `fabric`, `gsm` (custom
fields). **Lightest batch — no plugin code, no Medusa rebuild:** a pure
mapping-row change (`plugin/add-product-attribute-mappings.sql`, idempotent — 4
`push` pairs on the Product↔Item mapping, visible in the admin Mappings tab) +
Frappe custom fields (`frappe/item_attr_setup.py`, HSN as plain `hsn_code` not
regional `gst_hsn_code`) + `mapped._ensure_item_group` (Item Group is a
Link+tree doctype → auto-create the leaf before save; `_apply_defaults` already
fill-if-missing). Deliberately **excludes** `moq`/`case_pack`/`mrp` (moq flows
ERPNext→Medusa; mrp = pricing batch). Echo-safe: `pricing.on_item` honors
`frappe.flags.medusync_inbound`. Verified live: `pix-boxer-shorts` →
item_group `loungewear` (auto-created, count stays 1 on re-push), hsn_code
61071900, gsm 145, fabric unset (none in metadata). Still unsynced (no source
data): variant barcode, colour/size options (ERPNext variant templates), brand.

**B2B tier pricing (ERPNext price lists → Medusa `b2b_pricing`)** — closes audit
gap #2/#7 (per-tier price depth). An Item Price on a **tier-mapped** price list
now becomes a standalone `b2b_price_tier` (PriceTier) row the storefront engine
resolves via `getPriceTiers(product_id,{tier_ids})`. Mapping is operator config:
a `medusa_customer_tier` Custom Field on ERPNext Price List holds a
`customer_tier.code` (seed: Wholesale→local_mbo, Distributor→regional_distributor
— demo data, ops remaps). Frappe: `pricing.on_item_price`'s non-selling
early-return becomes a tier branch → `variant.tier_price.set {sku,tier_code,
amount,deleted}`. Plugin: `dispatchInbound` `variant.tier_price.set` →
`_handleVariantTierPrice` resolves variant→**product_id** (engine queries by
product_id) + tier by code, upserts PriceTier `{product_id,variant_id,
customer_tier_id,min_quantity:1,value(paise),is_percentage:false,rule_id:null,
price_list_id:null}` idempotent on (variant,tier,min_q); deleted→hard-delete.
Never sets `price_list_id` or touches DynamicRule (leaves Phase-4.5
`projectTierToPriceList` alone — this populates upstream, that projects
downstream). Rupees→paise ×100. Echo-safe (`_guard()` honors medusync_inbound).
Verified via the engine's OWN getPriceTiers: local_mbo→64000, regional_
distributor→59000; re-fire = 1 row/tier (idempotent); delete Item Price →
getPriceTiers(local_mbo)=[]. **Quantity ladders (extension, done):** ERPNext
Item Price `packing_unit` (native, part of the duplicate-check key → multiple
prices per item+list allowed) maps to PriceTier `min_quantity`; handler keys
idempotency on (variant,tier,min_quantity) so brackets coexist + delete
independently. Verified: Wholesale packing_unit 1/50/100 (₹640/600/560) →
getPriceTiers ladder [{1,64000},{50,60000},{100,56000}]; delete pack50 → only
the min_q=50 bracket goes. Repo files:
`plugin/modules/erpnext/index.ts`, `frappe/handlers/pricing.py`,
`frappe/tier_setup.py`, `docs/B2B_TIER_PRICING_DESIGN.md`.

**Housekeeping** — plugin `retryEvent(eventId, scope?)` fixed both replay
defects: outbound mapped rows replay via `pushViaMapping` (re-runs the mapping
transform, not a stale full-payload `forwardEvent`); inbound rows re-apply via
`dispatchInbound(..., scope)` instead of being mis-pushed outbound. The retry
API route now passes `req.scope`. Duplicate/broken Medusync Mappings removed
(kept a single `Customer ↔ Customer`). Re-audit in
`INTEGRATION_AUDIT_REPORT_V2.md`.

**Ops** — `hooks.py` also comments the Procfile `schedule:` line note; admin
login fixed via `cookieOptions` (see `medusa-config.ts` note above).

## Apply order (fresh env)
1. Plugin: apply the 3 files → build via the `pluginbuild` junction → copy
   `.medusa` into `node_modules/medusa-plugin-erpnext` → `medusa build` → start.
2. Sandbox: add the module/routes/page/lib + the 2 `medusa-config`/seed edits →
   `db:migrate` → build.
3. Frappe: copy the 4 handlers into `handlers/risitex/`; apply `hooks.py`; run
   the setup scripts (Custom Fields, Property Setter, mappings); restart bench
   (Procfile `schedule:` commented).

## Status
All features verified live (see each `*_RESULTS.md` and
`INTEGRATION_AUDIT_REPORT_V2.md`). **Published at `mithtech-is/erpnextsync`; the
real `risitex-mainb2b` app repo remains untouched.** Returns/Refunds, Pricing/B2B
(tiers + quantity ladders), the retry/mapping housekeeping, and the
Medusa-initiated return-request last-mile are all included. Remaining
(non-CRITICAL, per V2 audit): **advanced/B2B pricing depth is now largely done**
— per-tier prices and quantity ladders sync (see the B2B tier pricing batch
above); still open: percentage/discount Pricing Rules (rate-based tiers done)
and **MRP**. Rich product attributes are also **partially done** (metadata
textile fields); the remainder (variant barcode, colour/size option templates,
brand) has no Medusa-side source data yet.
