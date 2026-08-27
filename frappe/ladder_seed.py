import frappe

def run():
    SKU="audit-var-1"; PL="Wholesale"
    # Base bracket already exists (packing_unit 0/1, rate 640). Add 50 and 100.
    for pack, rate in ((50, 600.0), (100, 560.0)):
        ip = frappe.db.get_value("Item Price", {"item_code":SKU,"price_list":PL,"packing_unit":pack}, "name")
        if ip:
            frappe.db.set_value("Item Price", ip, "price_list_rate", rate)
        else:
            frappe.get_doc({
                "doctype":"Item Price","item_code":SKU,"price_list":PL,
                "price_list_rate":rate,"currency":"INR","selling":1,"packing_unit":pack,
            }).insert(ignore_permissions=True)
    frappe.db.commit()
    print("LADDER seeded: pack1->640, pack50->600, pack100->560")
