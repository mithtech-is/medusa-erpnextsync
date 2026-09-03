# Variant options, barcode, brand — deferred 2026-09-04

**Requirement.** Variants sync ERPNext → Medusa with SKU, name, attributes,
options, barcode, UOM, weight; images ERPNext → Medusa.

**State.** `metadata.category → item_group`, `hsn_code`, `fabric`, `gsm`
sync as flat fields (`docs/PRODUCT_ATTRIBUTES_DESIGN.md`). Colour/size
option templates (ERPNext Item variant templates ↔ Medusa options), variant
barcode, UOM and brand are not implemented, and the sandbox has no source
data for them.

**Dependencies.** Phase 3 product/variant entity work; seeded ERPNext Item
templates with attributes; Medusa products with real options.
