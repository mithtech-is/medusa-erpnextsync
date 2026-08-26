F = "/home/divya/frappe-bench/apps/medusync/medusync/hooks.py"
src = open(F).read()
if '"Stock Ledger Entry"' in src:
    print("already hooked")
    raise SystemExit(0)
anchor = '\t"Medusync Mapping": {'
if anchor not in src:
    print("ANCHOR NOT FOUND")
    raise SystemExit(1)
block = (
    '\t"Stock Ledger Entry": {\n'
    '\t\t"after_insert": "medusync.handlers.risitex.inventory.on_sle",\n'
    '\t},\n'
)
src = src.replace(anchor, block + anchor, 1)
open(F, "w").write(src)
print("hooked Stock Ledger Entry")
