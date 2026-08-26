F = "/home/divya/frappe-bench/apps/medusync/medusync/hooks.py"
src = open(F).read()
if '"Item Price"' in src:
    print("already hooked pricing")
    raise SystemExit(0)
anchor = '\t"Medusync Mapping": {'
if anchor not in src:
    print("ANCHOR NOT FOUND")
    raise SystemExit(1)
block = (
    '\t"Item Price": {\n'
    '\t\t"after_insert": "medusync.handlers.risitex.pricing.on_item_price",\n'
    '\t\t"on_update": "medusync.handlers.risitex.pricing.on_item_price",\n'
    '\t\t"on_trash": "medusync.handlers.risitex.pricing.on_item_price",\n'
    '\t},\n'
    '\t"Item": {\n'
    '\t\t"on_update": "medusync.handlers.risitex.pricing.on_item",\n'
    '\t},\n'
    '\t"Customer": {\n'
    '\t\t"after_insert": "medusync.handlers.risitex.pricing.on_customer_group_link",\n'
    '\t\t"on_update": "medusync.handlers.risitex.pricing.on_customer_group_link",\n'
    '\t},\n'
)
src = src.replace(anchor, block + anchor, 1)
open(F, "w").write(src)
import ast
ast.parse(src)
print("hooked Item Price + Item + Customer")
