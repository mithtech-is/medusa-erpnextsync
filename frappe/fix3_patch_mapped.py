F = "/home/divya/frappe-bench/apps/medusync/medusync/handlers/risitex/mapped.py"
src = open(F).read()
changed = False

# 1. import (top-level, after 'import frappe')
if "from medusync.handlers.risitex.sales_financials import apply_financials" not in src:
    anchor = "import frappe\n"
    i = src.index(anchor) + len(anchor)
    src = src[:i] + "from medusync.handlers.risitex.sales_financials import apply_financials\n" + src[i:]
    changed = True

# 2. call apply_financials before the create-path insert
old = (
    '\tif not doc.get("items"):\n'
    '\t\traise Exception("no valid line items for %s" % doctype)\n'
    '\tdoc.insert(ignore_permissions=True)'
)
new = (
    '\tif not doc.get("items"):\n'
    '\t\traise Exception("no valid line items for %s" % doctype)\n'
    '\tapply_financials(doc, customer, payload)\n'
    '\tdoc.insert(ignore_permissions=True)'
)
if "apply_financials(doc, customer, payload)" not in src:
    if old not in src:
        print("CREATE-PATH ANCHOR NOT FOUND")
        raise SystemExit(1)
    src = src.replace(old, new, 1)
    changed = True

open(F, "w").write(src)
import ast
ast.parse(src)
print("patched mapped.py" if changed else "already patched", "(syntax OK)")
