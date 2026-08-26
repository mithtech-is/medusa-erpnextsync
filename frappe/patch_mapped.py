F = "/home/divya/frappe-bench/apps/medusync/medusync/handlers/risitex/mapped.py"
src = open(F).read()

# Idempotency sentinel.
if 'status_field = doc.meta.get_field("status")' in src:
    print("already patched")
    raise SystemExit(0)

lines = src.split("\n")
anchor = "frappe.delete_doc(doctype, existing, ignore_permissions=True)"
out = []
patched = False
for ln in lines:
    if ln.strip() == anchor and not patched:
        indent = ln[: len(ln) - len(ln.lstrip())]
        out.append(indent + 'status_field = doc.meta.get_field("status")')
        out.append(indent + 'if status_field and "Cancelled" in (status_field.options or ""):')
        out.append(indent + "\t" + 'doc.db_set("status", "Cancelled")')
        out.append(indent + "\t" + 'return {"doctype": doctype, "name": existing, "status": "updated", "action": "cancelled"}')
        patched = True
    out.append(ln)

if not patched:
    print("ANCHOR NOT FOUND")
    raise SystemExit(1)

open(F, "w").write("\n".join(out))
print("patched mapped.py (safe-delete -> Cancelled for status-bearing doctypes)")
