# Rich product attributes (Medusa product.metadata → ERPNext Item)

Partially closes audit gap #1 (rich product attributes not synced).
Built + verified live on the demo stack, 2026-08-27.

## Correction to the record

An earlier note claimed rich attributes had "no source data on either side."
That is wrong for the **metadata** fields: RISITEX products carry
`metadata.category`, `metadata.hsn_code`, `metadata.fabric`, `metadata.gsm`
(from the B2B seed). Native `product.categories` links also exist. What's
genuinely absent is variant **barcode / hs_code / material** (all 0) and rich
colour/size **options** (placeholder "Default"/"Size") — those still need
seeding + the ERPNext variant-template machinery, and remain out of scope.

## What syncs

On `product.created` / `product.updated` (Medusa → ERPNext Item), four
metadata attributes now carry to the Item:

| Medusa | ERPNext Item field |
|---|---|
| `metadata.category` | `item_group` (auto-created if missing) |
| `metadata.hsn_code` | `hsn_code` (custom field) |
| `metadata.fabric` | `fabric` (custom field) |
| `metadata.gsm` | `gsm` (custom field, Int) |

**Deliberately excluded** from the outbound push: `metadata.moq` (flows the
other way — `Item.min_order_qty` → `variant.metadata.moq`, ERPNext wins),
`metadata.case_pack`, and `metadata.mrp` (belongs to the pricing batch).
Pushing any of these would fight the existing pricing sync.

## Implementation (lightest batch — no plugin code, no Medusa rebuild)

Because all four are flat `metadata.*` paths, the existing mapping engine
extracts them — this is a **pure mapping-row change** plus a small Frappe hook:

1. **Mapping**: four `direction:"push"` field-mapping pairs added to the enabled
   Product↔Item mapping (`add-product-attribute-mappings.sql`, idempotent).
   Visible/editable in the admin **Mappings** tab.
2. **Frappe custom fields**: `Item.hsn_code`, `Item.fabric`, `Item.gsm`
   (`item_attr_setup.py`). HSN uses the plain fieldname `hsn_code`, NOT the
   regional `gst_hsn_code`, to avoid a migrate collision if India Compliance is
   ever installed.
3. **Frappe `mapped.py`**: `_ensure_item_group(name)` — Item Group is a Link +
   tree doctype, so a category value that isn't an existing group would fail the
   Item save with a LinkValidationError. It auto-creates the group as a leaf
   under "All Item Groups" before the save. `_apply_defaults` is already
   fill-if-missing, so the mapped `item_group` is not clobbered.

**Echo safety**: an inbound Item write fires `pricing.on_item`
(`variant.meta.set` back to Medusa), but `pricing._guard()` returns false when
`frappe.flags.medusync_inbound` is set (which `mapped.upsert_via_mapping` sets),
so there is no echo loop.

## Verified live (E2E)

Pushed `pix-boxer-shorts` (`metadata`: category=loungewear, hsn=61071900,
gsm=145, no fabric) through the Product↔Item mapping:
- ERPNext Item `item_group = loungewear` (**Item Group auto-created**),
  `hsn_code = 61071900`, `gsm = 145`, `fabric` unset (none in metadata — no
  false data), `medusa_product_id` stamped.
- Pushed repeatedly → Item Group "loungewear" count stays **1** (idempotent, no
  duplicate groups).

## Scope

Metadata-sourced textile attributes only. Variant barcode, colour/size options
(ERPNext variant templates), and brand remain unsynced — no source data on the
Medusa side yet.
