-- Rich product attributes (Medusa product.metadata -> ERPNext Item).
-- Adds 4 flat push pairs to the enabled Product <-> Item mapping. Idempotent:
-- strips any prior copies of these medusa_paths before appending.
-- Deliberately EXCLUDES metadata.moq / case_pack / mrp:
--   moq flows ERPNext->Medusa (Item.min_order_qty -> variant.metadata.moq) and
--   mrp belongs to the pricing batch — pushing them here would fight those.
UPDATE erpnext_mapping
SET field_mappings = (
    (SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
     FROM jsonb_array_elements(field_mappings) elem
     WHERE elem->>'medusa_path' NOT IN (
         'metadata.category', 'metadata.hsn_code', 'metadata.fabric', 'metadata.gsm'
     ))
    || '[
        {"direction":"push","medusa_path":"metadata.category","erpnext_field":"item_group"},
        {"direction":"push","medusa_path":"metadata.hsn_code","erpnext_field":"hsn_code"},
        {"direction":"push","medusa_path":"metadata.fabric","erpnext_field":"fabric"},
        {"direction":"push","medusa_path":"metadata.gsm","erpnext_field":"gsm"}
    ]'::jsonb
)
WHERE medusa_entity = 'product' AND enabled = true;
