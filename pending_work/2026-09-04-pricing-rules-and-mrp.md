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

## Questions this is waiting on

See `00-QUESTIONS-ANSWER-THESE-FIRST.md`.

- **Q4** — where a percentage or discount Pricing Rule lands in Medusa.
  Metadata, a price-list rule, or a promotion are three different amounts of
  work and only one of them enforces the discount at checkout.
- **Q5** — where MRP lands. Metadata is display-only; a second price list
  lets the storefront strike it through with real price machinery.
- **Q6** — whether you seed a demo site with Pricing Rules, or I add the
  `Item.mrp` field and seed a couple myself.

Q6 is the practical blocker: none of this can be verified against a site
that has no Pricing Rules on it.
