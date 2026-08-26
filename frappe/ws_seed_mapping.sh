#!/bin/bash
cd /home/divya/frappe-bench
export PATH="$HOME/.local/bin:$PATH"
echo "=== direction Select options ==="
bench --site site1.local execute frappe.client.get_value --kwargs "{'doctype':'DocField','filters':{'parent':'Medusync Mapping','fieldname':'direction'},'fieldname':['options']}" 2>/dev/null | tail -1
cat > apps/medusync/medusync/_ws_seed.py <<'PY'
import frappe
def run():
    name = "Wallet Settlement to Medusa"
    if frappe.db.exists("Medusync Mapping", name):
        print("exists:", name); return
    fields = [
        ("settlement_batch_id","settlement_batch_id"),
        ("period_from","period_from"),("period_to","period_to"),
        ("total_credits","total_credits"),("total_debits","total_debits"),
        ("net_amount","net_amount"),("currency","currency"),("status","status"),
    ]
    doc = frappe.get_doc({
        "doctype": "Medusync Mapping",
        "title": name,
        "enabled": 1,
        "document_type": "RISITEX Wallet Settlement",
        "direction": "Two-way",
        "key_field": "settlement_batch_id",
        "docevents": "after_insert\non_update\non_trash",
        "include_all_fields": 0,
        "allow_insert": 1, "allow_update": 1, "allow_delete": 0,
        "medusa_event": "",
        "field_map": [
            {"medusa_path": mp, "frappe_field": ff, "direction": "Two-way"}
            for (mp, ff) in fields
        ],
    })
    doc.insert(ignore_permissions=True)
    frappe.db.commit()
    print("created", doc.name)
PY
bench --site site1.local execute medusync._ws_seed.run
