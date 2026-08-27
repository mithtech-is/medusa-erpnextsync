import frappe

def run():
    created = []
    # Textile attributes carried from Medusa product.metadata. HSN uses the
    # plain fieldname (NOT gst_hsn_code) to avoid colliding with the standard
    # regional field if India Compliance is ever installed.
    fields = [
        {"fieldname": "hsn_code", "label": "HSN Code", "fieldtype": "Data"},
        {"fieldname": "fabric",   "label": "Fabric",   "fieldtype": "Data"},
        {"fieldname": "gsm",      "label": "GSM",       "fieldtype": "Int"},
    ]
    for f in fields:
        cf = "Item-%s" % f["fieldname"]
        if frappe.db.exists("Custom Field", cf):
            continue
        frappe.get_doc({
            "doctype": "Custom Field", "dt": "Item",
            "fieldname": f["fieldname"], "label": f["label"], "fieldtype": f["fieldtype"],
            "insert_after": "item_group",
            "description": "Synced from Medusa product metadata (medusync).",
        }).insert(ignore_permissions=True)
        created.append(cf)
    frappe.db.commit()
    print("ITEM_ATTR_SETUP created:", created or "already present")

if __name__ == "__main__":
    run()
