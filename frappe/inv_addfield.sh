#!/bin/bash
cd /home/divya/frappe-bench; export PATH="$HOME/.local/bin:$PATH"
cat > apps/medusync/medusync/_inv_field.py <<'PY'
import frappe
def run():
    if frappe.db.exists("Custom Field", "Medusync Settings-inventory_source_warehouse"):
        print("exists"); return
    frappe.get_doc({
        "doctype": "Custom Field",
        "dt": "Medusync Settings",
        "fieldname": "inventory_source_warehouse",
        "label": "Inventory Source Warehouse",
        "fieldtype": "Link",
        "options": "Warehouse",
        "default": "Finished Goods - R",
        "description": "Stock at this warehouse drives Medusa on-hand (ERPNext -> Medusa).",
    }).insert(ignore_permissions=True)
    frappe.db.set_single_value("Medusync Settings", "inventory_source_warehouse", "Finished Goods - R")
    frappe.db.commit()
    print("added inventory_source_warehouse")
PY
bench --site site1.local execute medusync._inv_field.run
echo "=== verify ==="
bench --site site1.local execute frappe.client.get_single_value --kwargs "{'doctype':'Medusync Settings','field':'inventory_source_warehouse'}"
