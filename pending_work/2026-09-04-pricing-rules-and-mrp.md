# Percentage / discount Pricing Rules and MRP — deferred 2026-09-04

**Requirement.** Price lists sync bidirectionally with per-list direction.
Rate-based tier prices and quantity ladders already sync
(`variant.tier_price.set`, see `docs/B2B_TIER_PRICING_DESIGN.md`). Still
open:
- ERPNext **Pricing Rules** expressed as percentages or discounts (not flat
  rates) have no Medusa counterpart in the plugin.
- **MRP** (maximum retail price) display value has no Item field and no
  Medusa target.

**Dependencies.** Phase 3 price-list work (per-list direction + site); an
ERPNext demo site with Pricing Rules seeded; a decision on the Medusa target
(price-list rule vs. metadata) per project.
