import frappe

def run():
    # 1) Custom Field on Price List holding the Medusa customer-tier CODE.
    cf = "Price List-medusa_customer_tier"
    if not frappe.db.exists("Custom Field", cf):
        frappe.get_doc({
            "doctype": "Custom Field", "dt": "Price List",
            "fieldname": "medusa_customer_tier", "label": "Medusa Customer Tier (code)",
            "fieldtype": "Data", "insert_after": "selling",
            "description": "Maps this price list to a Medusa customer_tier.code (medusync B2B tier pricing).",
        }).insert(ignore_permissions=True)
        print("created custom field")

    # 2) Seed two tier-mapped selling price lists (DEMO mapping — ops remaps).
    seed = [
        ("Wholesale", "local_mbo", 640.0),
        ("Distributor", "regional_distributor", 590.0),
    ]
    SKU = "audit-var-1"
    for pl, tier, rate in seed:
        if not frappe.db.exists("Price List", pl):
            frappe.get_doc({
                "doctype": "Price List", "price_list_name": pl,
                "selling": 1, "currency": "INR", "medusa_customer_tier": tier,
            }).insert(ignore_permissions=True)
        else:
            frappe.db.set_value("Price List", pl, "medusa_customer_tier", tier)
        # Item Price for the sku on this list
        ip = frappe.db.get_value("Item Price", {"item_code": SKU, "price_list": pl}, "name")
        if ip:
            frappe.db.set_value("Item Price", ip, "price_list_rate", rate)
        else:
            frappe.get_doc({
                "doctype": "Item Price", "item_code": SKU, "price_list": pl,
                "price_list_rate": rate, "currency": "INR", "selling": 1,
            }).insert(ignore_permissions=True)
    frappe.db.commit()
    print("SEED done:", seed)

if __name__ == "__main__":
    run()
