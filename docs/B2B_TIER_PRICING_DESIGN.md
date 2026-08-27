# B2B tier pricing (ERPNext price lists → Medusa b2b_pricing)

Closes audit gap #2/#7 (per-group/tier price depth not synced).
Built + verified live on the demo stack, 2026-08-27.

## Before

`pricing.on_item_price` only synced the **selling** price list (Standard
Selling) → the variant base price. Item Prices on any other list (Wholesale,
Dealer, …) were dropped, so B2B tier/volume pricing never reached Medusa.

## After

An Item Price on a **tier-mapped** price list becomes a standalone
`b2b_pricing` **PriceTier** row — the same rows the storefront's B2B pricing
engine resolves through `getPriceTiers(product_id, {tier_ids})`.

### The mapping (config, not hard-code)

A Custom Field `medusa_customer_tier` on ERPNext **Price List** holds a Medusa
`customer_tier.code` (e.g. `local_mbo`). Ops decides which price list feeds
which tier by editing the Price List doc — same operator-config pattern as
`inventory_source_warehouse` / `pricing_selling_price_list`. The seed mapping
(**Wholesale → local_mbo**, **Distributor → regional_distributor**) is **demo
data**, not product truth.

### Why it doesn't collide with Phase 4.5

The engine has a planned `projectTierToPriceList` that projects PriceTier rows
*down* to native Medusa Price Lists (the `price_list_id` mirror, "PriceTier is
the source of truth"). This sync populates PriceTier *up* from ERPNext —
consistent with the standing "ERPNext price always wins" rule. They're
complementary. Two guard-rails keep this sync in its lane:
**never set `price_list_id`** (mirror field — left null) and **never create
native Medusa price lists or touch DynamicRule**.

## Implementation

**Frappe** (`pricing.py`): the non-selling early-return becomes a tier branch —
if the Item Price's price list has `medusa_customer_tier` set, emit
`variant.tier_price.set {sku, tier_code, amount, currency, deleted}`. Setup
(`tier_setup.py`): the Price List Custom Field + the two demo lists/Item Prices.

**Plugin** (`index.ts`): `dispatchInbound` case `variant.tier_price.set` →
`_handleVariantTierPrice`:
- resolve variant by sku → `variant_id` + **`product_id`** (the engine queries
  PriceTier by `product_id`, so a variant-only row would never resolve);
- resolve the tier by `code` via the `customer_tier` module;
- upsert a PriceTier `{product_id, variant_id, customer_tier_id,
  min_quantity: 1, value (paise), is_percentage: false, rule_id: null,
  price_list_id: null}`, idempotent on `(variant_id, customer_tier_id,
  min_quantity)`;
- `deleted` / null amount → hard-delete the row (ERPNext wins, no stale price).

Values arrive in **rupees** and are stored in **paise** (`× 100`), matching the
engine ("values are in MINOR units").

**Echo-safe**: inbound writes are guarded by `frappe.flags.medusync_inbound`
(`pricing._guard()`), so a synced row doesn't bounce back.

## Verified live (E2E)

Seeded Wholesale (₹640 → local_mbo) + Distributor (₹590 → regional_distributor)
Item Prices for `audit-var-1`, fired the ERPNext hooks, then **read back through
the engine's own `getPriceTiers`**:

- `getPriceTiers(local_mbo)` → value **64000** paise (₹640).
- `getPriceTiers(regional_distributor)` → value **59000** paise (₹590).
- Rows have `price_list_id = null`, `rule_id = null` (mirror + DynamicRule
  untouched).
- Re-fired repeatedly → **still one row per tier** (idempotent).
- Deleted the Wholesale Item Price → `getPriceTiers(local_mbo)` → **[]** (row
  hard-deleted), regional_distributor unaffected.

## Scope / known limitations

- **Flat per-tier price only** (`min_quantity: 1`). Quantity ladders are
  deferred: this bench's Item Price has no min-qty field, so ERPNext quantity
  breaks live in Pricing Rules — translating those is a batch of its own. The
  PriceTier shape already supports `min_quantity`/`max_quantity`, so ladders
  ride the same handler once a qty source exists.
- **Delete via Frappe UI** is currently blocked by ERPNext referential
  integrity: the outbound Medusync Log stamps `document_name` (a Dynamic Link)
  onto the Item Price, so deleting it raises `LinkExistsError` until the log is
  unlinked. This is **pre-existing** and affects every pricing delete-sync
  (including `variant.price.set`), not just tiers — worth fixing separately by
  making the Medusync Log link non-blocking.
