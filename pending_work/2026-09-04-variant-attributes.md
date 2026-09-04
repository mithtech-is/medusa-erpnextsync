# Variant options, barcode, brand — deferred 2026-09-04

**Requirement.** Variants sync ERPNext → Medusa with SKU, name, attributes,
options, barcode, UOM, weight; images ERPNext → Medusa.

**State.** `metadata.category → item_group`, `hsn_code`, `fabric`, `gsm`
sync as flat fields. Colour/size
option templates (ERPNext Item variant templates ↔ Medusa options), variant
barcode, UOM and brand are not implemented, and the sandbox has no source
data for them.

**Dependencies.** Phase 3 product/variant entity work; seeded ERPNext Item
templates with attributes; Medusa products with real options.

## Questions this is waiting on

See `00-QUESTIONS-ANSWER-THESE-FIRST.md`.

- **Q7** — whether ERPNext variant templates become Medusa product options
  or separate products. This is the shape of the whole feature: options give
  a storefront its size picker, separate products do not.
- **Q8** — which Item Attributes are the option axes, or whether to read
  them from each Item.
- **Q9** — where barcode, UOM and brand each land.

Q7 first. Q8 and Q9 are details inside whichever answer it gets.
