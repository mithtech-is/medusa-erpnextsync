#!/bin/bash
cd /home/divya/frappe-bench
export PATH="$HOME/.local/bin:$PATH"
cat > apps/medusync/medusync/_ws_status.py <<'PY'
import frappe
from frappe.custom.doctype.property_setter.property_setter import make_property_setter

def run():
    meta = frappe.get_meta("RISITEX Wallet Settlement")
    f = meta.get_field("status")
    if not f:
        print("no status field"); return
    opts = [o.strip() for o in (f.options or "").split("\n") if o.strip()]
    if "Cancelled" in opts:
        print("already present:", "/".join(opts)); return
    opts.append("Cancelled")
    make_property_setter(
        "RISITEX Wallet Settlement", "status", "options", "\n".join(opts),
        "Text", validate_fields_for_doctype=False,
    )
    frappe.db.commit()
    frappe.clear_cache(doctype="RISITEX Wallet Settlement")
    print("added via property setter:", "/".join(opts))
PY
bench --site site1.local execute medusync._ws_status.run
echo "=== verify ==="
bench --site site1.local execute frappe.client.get_value --kwargs "{'doctype':'Property Setter','filters':{'doc_type':'RISITEX Wallet Settlement','field_name':'status','property':'options'},'fieldname':['value']}"
