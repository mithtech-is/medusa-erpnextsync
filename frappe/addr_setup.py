import frappe

def run():
    created = []
    # Idempotent custom field: stable Medusa address id -> ERPNext Address,
    # so re-pushes update the same Address instead of duplicating it.
    if not frappe.db.exists("Custom Field", "Address-medusa_address_id"):
        frappe.get_doc({
            "doctype": "Custom Field",
            "dt": "Address",
            "fieldname": "medusa_address_id",
            "label": "Medusa Address ID",
            "fieldtype": "Data",
            "read_only": 1,
            "unique": 1,
            "no_copy": 1,
            "description": "Stable id of the Medusa customer address this record mirrors (medusync).",
        }).insert(ignore_permissions=True)
        created.append("Address-medusa_address_id")
    frappe.db.commit()
    print("ADDR_SETUP created:", created or "already present")

if __name__ == "__main__":
    run()
