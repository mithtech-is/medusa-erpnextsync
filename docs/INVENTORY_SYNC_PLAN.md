# Inventory (stock-level) sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ERPNext the source of truth for stock and push each stock-level change to Medusa in real time, per-SKU, one-way.

**Architecture:** A medusync `doc_events` hook on **Stock Ledger Entry** reads the item's `Bin.actual_qty` at the configured source warehouse and delivers a signed `inventory.level.set` event through the **existing** `medusync.outbound.deliver` pipe to the plugin's existing `/webhooks/erpnext-inbound` receiver. The plugin's `dispatchInbound` gets a new `inventory.level.set` case that sets `InventoryLevel.stocked_quantity` for the `inventory_item` whose `sku == item_code`. Reuses all HMAC signing, `ts` replay window, `event_id` idempotency, and Medusync Log / erpnext_sync_event logging already in place.

**Tech Stack:** Frappe/ERPNext 16 (doc_events, Bin, Stock Reconciliation), Python; the generic `medusa-plugin-erpnext` (TS module method + route already exist), Medusa v2 Inventory + Stock Location modules.

**Testing note:** Cross-system integration — verification is the round-trip (post stock in ERPNext → assert the Medusa level), consistent with the wallet-settlement build. No unit-test harness exists; don't invent one.

**Environment constants:** same as `WALLET_SETTLEMENT_SYNC_PLAN.md` — plugin at `$P` (build via `pluginbuild` junction), sandbox backend `$B`, Medusa `:9000` / admin `:7001` (`serve-admin.js`, prod mode `medusa start`), Frappe `site1.local` as WSL user `divya`, run Frappe scripts via `MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/…/x.sh`. Demo admin `demo-admin@example.com` / `Demo12345!`. Source warehouse default `Finished Goods - R`.

---

## File Structure

**Modify (plugin `$P`):**
- `src/modules/erpnext/index.ts` — add `case "inventory.level.set"` in `dispatchInbound` + a private `_handleInventoryLevelSet` method. (Ensure `Modules` is imported — it is, used elsewhere.)

**Create / modify (Frappe medusync app):**
- `medusync/handlers/risitex/inventory.py` (new) — the SLE hook `on_sle`.
- `medusync/hooks.py` (modify) — register the Stock Ledger Entry hook.
- Custom Field `inventory_source_warehouse` on `Medusync Settings` (via script).

**Frappe demo scripts (run via bench, dropped into the app pkg):**
- Seed SKU-level stock Items + Stock Reconciliation at Finished Goods - R.

No sandbox app code changes and **no new Medusa UI** (stock is read-only in Medusa; native views show it).

---

## Task 1: Medusa receiver — `inventory.level.set` handler (plugin)

**Files:**
- Modify: `$P/src/modules/erpnext/index.ts`

- [ ] **Step 1: Add the private handler**

In `$P/src/modules/erpnext/index.ts`, add this method to the `ErpnextModuleService` class (near the other `_handle*` inbound handlers):
```ts
/**
 * Set a Medusa inventory level from an ERPNext stock update. One-way:
 * ERPNext owns stock. Keyed by sku == ERPNext item_code. Unknown sku →
 * logged skip (not an error). Single stock location (or INVENTORY_LOCATION_ID).
 */
private async _handleInventoryLevelSet(data: any, event_id: string, scope: any) {
    const sku = String(data?.sku ?? "").trim()
    const quantity = Number(data?.quantity)
    if (!sku || !Number.isFinite(quantity)) {
        return { skipped: true, reason: "missing sku or quantity" }
    }
    const inv: any = scope.resolve(Modules.INVENTORY)
    const [item] = await inv.listInventoryItems({ sku }, { take: 1 })
    if (!item) {
        return { skipped: true, reason: `no inventory item for sku ${sku}` }
    }
    const locSvc: any = scope.resolve(Modules.STOCK_LOCATION)
    const locId =
        process.env.INVENTORY_LOCATION_ID ||
        (await locSvc.listStockLocations({}, { take: 1 }))?.[0]?.id
    if (!locId) {
        return { skipped: true, reason: "no stock location" }
    }
    const [level] = await inv.listInventoryLevels(
        { inventory_item_id: item.id, location_id: locId },
        { take: 1 },
    )
    if (level) {
        await inv.updateInventoryLevels([
            { inventory_item_id: item.id, location_id: locId, stocked_quantity: quantity },
        ])
    } else {
        await inv.createInventoryLevels([
            { inventory_item_id: item.id, location_id: locId, stocked_quantity: quantity },
        ])
    }
    return { ok: true, sku, quantity, location_id: locId, inventory_item_id: item.id }
}
```

- [ ] **Step 2: Wire the event in `dispatchInbound`**

In the `switch (event)` inside `dispatchInbound`, add (next to the customer/wallet cases):
```ts
            // ── Inventory (ERPNext owns stock; one-way) ─────────────
            case "inventory.level.set":
                return this._handleInventoryLevelSet(data, event_id, scope)
```

- [ ] **Step 3: Confirm `Modules` import**

Run: `grep -n "Modules" "$P/src/modules/erpnext/index.ts" | head -3`
Expected: an import of `Modules` from `@medusajs/framework/utils` (or similar). If absent, add `import { Modules } from "@medusajs/framework/utils"` at the top.

- [ ] **Step 4: Typecheck**

Run (from `00-medusa/00-medusa/pluginbuild`): `./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "index.ts|error TS" | head`
Expected: no output.

- [ ] **Step 5: Build plugin → copy → rebuild+restart Medusa**
```bash
cd "/c/Users/KillerKoli/Divya/00-medusa/00-medusa/pluginbuild" && ./node_modules/.bin/medusa plugin:build
SRC="/c/Users/KillerKoli/Divya/00-medusa/00-medusa/pluginbuild/.medusa"
DST="/c/Users/KillerKoli/Divya/00-medusa/00-medusa/risitex-mainb2b/node_modules/medusa-plugin-erpnext/.medusa"
rm -rf "$DST" && cp -r "$SRC" "$DST"
cd "/c/Users/KillerKoli/Divya/00-medusa/00-medusa/risitex-mainb2b/apps/backend" && MEDUSA_BACKEND_URL=http://127.0.0.1:9000 ./node_modules/.bin/medusa build
```
Then kill the sandbox `medusa start` (CIM filter `00-medusa.*risitex-mainb2b`, NOT the `D:\` repo) and restart it; wait for "Server is ready".

- [ ] **Step 6: Direct receiver test (no ERPNext yet)**

Pick a real Medusa sku and post a correctly-signed `inventory.level.set` straight to the receiver, using the configured `frappe_to_medusa_secret`. Create `C:\Users\KillerKoli\inv_post.sh`:
```bash
#!/bin/bash
cd /home/divya/frappe-bench; export PATH="$HOME/.local/bin:$PATH"
python3 - "$1" "$2" <<'PY'
import sys, json, time, hmac, hashlib, urllib.request
sku, qty = sys.argv[1], float(sys.argv[2])
secret = "demo_inbound_secret_2026_risitex"  # = frappe_to_medusa_secret / outbound_secret
env = {"event":"inventory.level.set","event_id":f"test:inv:{sku}:{int(time.time())}",
       "data":{"sku":sku,"quantity":qty},"ts":int(time.time())}
body = json.dumps(env, separators=(",",":")).encode()
sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
req = urllib.request.Request("http://172.26.59.188:9000/webhooks/erpnext-inbound", data=body,
    headers={"Content-Type":"application/json","X-Medusa-Signature":sig,"X-Medusa-Event-Id":env["event_id"]})
try:
    r = urllib.request.urlopen(req, timeout=15); print(r.status, r.read().decode()[:300])
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:300])
PY
```
(NB Medusa runs on the Windows host; from WSL use the Windows-host IP for `:9000` — confirm with `ip route | awk '/default/{print $3}'` if `172.26.59.188` is wrong; that value is the WSL IP, the host is usually `172.26.48.1`. Use the host IP that reaches `:9000`.)
Run: `MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/inv_post.sh PIX-WIB-S 42`
Expected: `200 {"ok":true,"status":"success",...}`. Then read the Medusa level:
```bash
API=http://127.0.0.1:9000; TOKEN=$(curl -s "$API/auth/user/emailpass" -H "Content-Type: application/json" -d '{"email":"demo-admin@example.com","password":"Demo12345!"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s "$API/admin/inventory-items?limit=100" -H "Authorization: Bearer $TOKEN" | python -c "import sys,json;print([ (i['sku'], (i.get('location_levels') or [{}])[0].get('stocked_quantity')) for i in json.load(sys.stdin)['inventory_items'] if i['sku']=='PIX-WIB-S'])"
```
Expected: `[('PIX-WIB-S', 42)]`. (Bad-signature test: change one byte of `sig` → expect `HTTP 401`.)

---

## Task 2: Medusync config — `inventory_source_warehouse` setting

**Files:**
- Create (temp): `C:\Users\KillerKoli\inv_addfield.sh`

- [ ] **Step 1: Add the Custom Field via a bench script**

`C:\Users\KillerKoli\inv_addfield.sh`:
```bash
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
        "insert_after": "medusa_url",
    }).insert(ignore_permissions=True)
    frappe.db.set_single_value("Medusync Settings", "inventory_source_warehouse", "Finished Goods - R")
    frappe.db.commit()
    print("added inventory_source_warehouse")
PY
bench --site site1.local execute medusync._inv_field.run
```
Run: `MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/inv_addfield.sh`
Expected: `added inventory_source_warehouse` (or `exists` on re-run). If `insert_after: medusa_url` errors (field name differs), drop the `insert_after` key and re-run.

- [ ] **Step 2: Verify the value**

Run:
```bash
cat > /c/Users/KillerKoli/inv_getfield.sh <<'EOF'
#!/bin/bash
cd /home/divya/frappe-bench; export PATH="$HOME/.local/bin:$PATH"
bench --site site1.local execute frappe.client.get_single_value --kwargs "{'doctype':'Medusync Settings','field':'inventory_source_warehouse'}"
EOF
MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/inv_getfield.sh
```
Expected: prints `Finished Goods - R`.

---

## Task 3: Medusync SLE hook

**Files:**
- Create: `/home/divya/frappe-bench/apps/medusync/medusync/handlers/risitex/inventory.py`
- Modify: `/home/divya/frappe-bench/apps/medusync/medusync/hooks.py`

- [ ] **Step 1: Write the hook handler**

Write `inventory.py` via a bench-run Python writer (the WSL path isn't reliably reachable by the Windows Write tool). Create `C:\Users\KillerKoli\inv_write_handler.sh`:
```bash
#!/bin/bash
cd /home/divya/frappe-bench; export PATH="$HOME/.local/bin:$PATH"
cat > apps/medusync/medusync/handlers/risitex/inventory.py <<'PY'
# ERPNext -> Medusa stock-level sync. One-way: ERPNext owns stock.
# Hooked on Stock Ledger Entry.after_insert (see hooks.py). Reads the
# item's Bin.actual_qty at the configured source warehouse and delivers
# a signed `inventory.level.set` through the existing outbound pipe.
import hashlib
import json

import frappe

from medusync import config
from medusync.outbound import _create_log, deliver

DEFAULT_SOURCE_WAREHOUSE = "Finished Goods - R"


def on_sle(doc, method=None):
    """Cheap, never raises — an exception here would abort the stock post."""
    try:
        if frappe.flags.get("medusync_inbound"):
            return
        if not config.is_enabled():
            return
        cfg = config.settings()
        source = getattr(cfg, "inventory_source_warehouse", None) or DEFAULT_SOURCE_WAREHOUSE
        if doc.warehouse != source:
            return
        item_code = doc.item_code
        qty = frappe.db.get_value(
            "Bin", {"item_code": item_code, "warehouse": source}, "actual_qty"
        )
        payload = {"sku": item_code, "quantity": float(qty or 0)}
        event = "inventory.level.set"
        # SLE name is unique per movement -> new event per change, and a
        # retry of the same movement dedupes on the Medusa side.
        event_id = f"frappe:inventory:{item_code}:{doc.name}"
        payload_hash = hashlib.sha256(
            json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
        log = _create_log(
            direction="Outbound",
            status="Queued",
            event=event,
            event_id=event_id,
            document_type="Stock Ledger Entry",
            document_name=doc.name,
            payload_hash=payload_hash,
            request_body=payload,
        )
        if cfg.use_background_jobs:
            frappe.enqueue(
                "medusync.outbound.deliver",
                queue="short",
                log_name=log.name,
                event_name=event,
                event_id=event_id,
                payload=payload,
                attempt=1,
                enqueue_after_commit=True,
            )
        else:
            deliver(log.name, event, event_id, payload, attempt=1)
    except Exception:
        frappe.log_error(
            title="medusync inventory hook failed",
            message=frappe.get_traceback(),
        )
PY
python3 -c "import ast; ast.parse(open('apps/medusync/medusync/handlers/risitex/inventory.py').read()); print('inventory.py: syntax OK')"
```
Run: `MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/inv_write_handler.sh`
Expected: `inventory.py: syntax OK`.

- [ ] **Step 2: Register the hook in hooks.py**

Add a Stock Ledger Entry entry to `doc_events` (it coexists with the wildcard `*`). Use a Python patcher `C:\Users\KillerKoli\inv_patch_hooks.py`:
```python
F = "/home/divya/frappe-bench/apps/medusync/medusync/hooks.py"
src = open(F).read()
if '"Stock Ledger Entry"' in src:
    print("already hooked"); raise SystemExit(0)
anchor = '\t"Medusync Mapping": {'
if anchor not in src:
    print("ANCHOR NOT FOUND"); raise SystemExit(1)
block = (
    '\t"Stock Ledger Entry": {\n'
    '\t\t"after_insert": "medusync.handlers.risitex.inventory.on_sle",\n'
    '\t},\n'
)
src = src.replace(anchor, block + anchor, 1)
open(F, "w").write(src)
print("hooked Stock Ledger Entry")
```
Run: `MSYS_NO_PATHCONV=1 wsl -u divya -- python3 /mnt/c/Users/KillerKoli/inv_patch_hooks.py`
Expected: `hooked Stock Ledger Entry`. Verify syntax:
`MSYS_NO_PATHCONV=1 wsl -u divya -- python3 -c "import ast; ast.parse(open('/home/divya/frappe-bench/apps/medusync/medusync/hooks.py').read()); print('hooks.py OK')"`

- [ ] **Step 3: Reload hooks**

`hooks.py` is read at boot. Restart the bench: kill the running `bench start` task and start it again (`MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/start_bench.sh` as a background task), wait for `web.1 … Running on http://…:8000`. (The dev watcher may reload on the .py change, but a hooks.py change needs a full restart to re-register doc_events.)

---

## Task 4: Demo seed — SKU stock Items + Stock Reconciliation

**Files:**
- Create (temp): `C:\Users\KillerKoli\inv_seed.sh`

- [ ] **Step 1: Seed SKU Items + post stock**

`C:\Users\KillerKoli\inv_seed.sh`:
```bash
#!/bin/bash
cd /home/divya/frappe-bench; export PATH="$HOME/.local/bin:$PATH"
cat > apps/medusync/medusync/_inv_seed.py <<'PY'
import frappe
SKUS = {"PIX-WIB-S": 25, "PIX-WIB-M": 15, "PIX-WIB-L": 8}
WAREHOUSE = "Finished Goods - R"
COMPANY = None
def _group():
    return frappe.db.get_value("Item Group", {"is_group": 0}, "name") or "All Item Groups"
def run():
    global COMPANY
    COMPANY = frappe.db.get_value("Company", {}, "name")
    for code in SKUS:
        if not frappe.db.exists("Item", code):
            frappe.get_doc({
                "doctype": "Item", "item_code": code, "item_name": code,
                "item_group": _group(), "stock_uom": "Nos", "is_stock_item": 1,
            }).insert(ignore_permissions=True)
    frappe.db.commit()
    sr = frappe.get_doc({
        "doctype": "Stock Reconciliation", "company": COMPANY,
        "purpose": "Stock Reconciliation",
        "items": [
            {"item_code": c, "warehouse": WAREHOUSE, "qty": q, "valuation_rate": 100}
            for c, q in SKUS.items()
        ],
    })
    sr.insert(ignore_permissions=True)
    sr.submit()
    frappe.db.commit()
    print("seeded + reconciled:", sr.name, dict(SKUS))
def show():
    for c in SKUS:
        print(c, frappe.db.get_value("Bin", {"item_code": c, "warehouse": WAREHOUSE}, "actual_qty"))
PY
bench --site site1.local execute medusync._inv_seed.run
```
Run: `MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/inv_seed.sh`
Expected: `seeded + reconciled: <SR-name> {'PIX-WIB-S': 25, 'PIX-WIB-M': 15, 'PIX-WIB-L': 8}`. (If "Nos" UOM missing, use `frappe.db.get_value("UOM", {}, "name")`. If Stock Reconciliation needs `expense_account`/`cost_center`, add the company defaults: `sr.expense_account = frappe.get_cached_value("Company", COMPANY, "stock_adjustment_account")`.)

Submitting the SR posts one SLE per item at Finished Goods → each fires `on_sle` → pushes to Medusa.

---

## Task 5: End-to-end verification

- [ ] **Step 1: Levels landed in Medusa**

```bash
API=http://127.0.0.1:9000; TOKEN=$(curl -s "$API/auth/user/emailpass" -H "Content-Type: application/json" -d '{"email":"demo-admin@example.com","password":"Demo12345!"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s "$API/admin/inventory-items?limit=200" -H "Authorization: Bearer $TOKEN" | python -c "import sys,json
w={i['sku']:(i.get('location_levels') or [{}])[0].get('stocked_quantity') for i in json.load(sys.stdin)['inventory_items']}
for s in ['PIX-WIB-S','PIX-WIB-M','PIX-WIB-L']: print(s, w.get(s))"
```
Expected: `PIX-WIB-S 25`, `PIX-WIB-M 15`, `PIX-WIB-L 8`.

- [ ] **Step 2: Change stock → Medusa follows**

Reconcile `PIX-WIB-S` to 10 (rerun the SR seed logic with `SKUS={"PIX-WIB-S":10}`), re-check → Medusa `PIX-WIB-S` = 10. Then to 0 → Medusa = 0.

- [ ] **Step 3: Non-source warehouse is ignored**

Post a Stock Reconciliation for `PIX-WIB-M` at **`Stores - R`** (qty 99). Re-check Medusa → `PIX-WIB-M` still 15 (unchanged). Confirms the source-warehouse filter.

- [ ] **Step 4: Unknown sku is a safe skip**

`MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/inv_post.sh NO-SUCH-SKU 5` → expect `200 {"skipped":true,...}` and no crash.

- [ ] **Step 5: Bad signature → 401** — mutate one hex char of the signature in `inv_post.sh` → expect `HTTP 401`.

- [ ] **Step 6: Regression** — one Customer create Medusa→ERPNext and one Wallet-Settlement create still sync (as in their result docs).

- [ ] **Step 7: Record results** in `00-medusa/00-medusa/INVENTORY_SYNC_RESULTS.md` (PASS/FAIL matrix), and capture the plugin diff + Frappe scripts into `wallet-settlement-changes/`'s sibling `inventory-sync-changes/` with a MANIFEST. Do NOT commit (awaiting go-ahead).

---

## Self-review notes
- **Spec coverage:** trigger=SLE hook (T3), source warehouse setting (T2), per-SKU key sku==item_code (T1 handler + T4 seed), Medusa receiver sets stocked_quantity (T1), demo seed (T4), one-way/no-loop (handler never emits; `medusync_inbound` guard), HMAC/ts/idempotency reused (existing receiver), E2E incl. non-source-ignored + unknown-sku + bad-sig + regression (T5). All spec sections covered.
- **Type/name consistency:** event name `inventory.level.set` identical in the medusync hook, the plugin `switch` case, and the direct-test script. Payload keys `sku`/`quantity` identical across producer (inventory.py), test script, and handler. Key = `item_code` (ERPNext) == `sku` (Medusa) throughout.
- **Reused, not rebuilt:** delivery via `medusync.outbound.deliver` (signs with `outbound_secret`, posts to `medusa_endpoint()` = `/webhooks/erpnext-inbound`), verified by the plugin's existing `receiveInbound` (HMAC + ts + event_id) before `dispatchInbound` routes to the new case — the same green path customer sync uses.
- **Risk flagged:** confirm the Windows-host IP that reaches Medusa `:9000` from WSL for the direct-test script (Step 1.6 note); confirm Stock Reconciliation's required company accounts on this demo (Step 4 note).
