F = "/home/divya/frappe-bench/apps/medusync/medusync/hooks.py"
src = open(F).read()
if '"Sales Order"' in src:
    print("already hooked SO")
    raise SystemExit(0)
anchor = '\t"Medusync Mapping": {'
if anchor not in src:
    print("ANCHOR NOT FOUND")
    raise SystemExit(1)
block = (
    '\t"Sales Order": {\n'
    '\t\t"on_submit": "medusync.handlers.risitex.inventory.on_sales_order",\n'
    '\t\t"on_cancel": "medusync.handlers.risitex.inventory.on_sales_order",\n'
    '\t\t"on_update_after_submit": "medusync.handlers.risitex.inventory.on_sales_order",\n'
    '\t},\n'
)
src = src.replace(anchor, block + anchor, 1)
open(F, "w").write(src)
print("hooked Sales Order")
