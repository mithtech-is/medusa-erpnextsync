F = "/home/divya/frappe-bench/apps/medusync/medusync/hooks.py"
src = open(F).read()
if '"Delivery Note"' in src:
    print("already hooked reverse")
    raise SystemExit(0)
anchor = '\t"Medusync Mapping": {'
if anchor not in src:
    print("ANCHOR NOT FOUND")
    raise SystemExit(1)
block = (
    '\t"Delivery Note": {\n'
    '\t\t"on_submit": "medusync.handlers.risitex.reverse.on_delivery_note",\n'
    '\t\t"on_cancel": "medusync.handlers.risitex.reverse.on_delivery_note",\n'
    '\t},\n'
    '\t"Shipment": {\n'
    '\t\t"on_submit": "medusync.handlers.risitex.reverse.on_shipment",\n'
    '\t\t"on_update_after_submit": "medusync.handlers.risitex.reverse.on_shipment",\n'
    '\t\t"on_cancel": "medusync.handlers.risitex.reverse.on_shipment",\n'
    '\t},\n'
    '\t"Sales Invoice": {\n'
    '\t\t"on_submit": "medusync.handlers.risitex.reverse.on_sales_invoice",\n'
    '\t\t"on_cancel": "medusync.handlers.risitex.reverse.on_sales_invoice",\n'
    '\t},\n'
)
src = src.replace(anchor, block + anchor, 1)
open(F, "w").write(src)
import ast
ast.parse(src)
print("hooked Delivery Note + Shipment + Sales Invoice")
