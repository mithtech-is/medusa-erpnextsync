# Wallet Settlement two-way sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `RISITEX Wallet Settlement` (ERPNext) and a new Medusa `wallet_settlement` module sync two-way through the generic medusync connector, with safe "Cancelled" delete semantics.

**Architecture:** A new Medusa `wallet_settlement` module (sandbox) holds settlement rows; its writes go through dedicated admin API routes that emit `wallet_settlement.{created,updated,deleted}` events. The generic plugin's forward-subscriber (auto-subscribed from the registry) pushes those to ERPNext; the plugin's inbound receiver applies ERPNext changes back via the registry `upsertByKey`/`disableByKey`. Inbound writes do NOT emit events, so there is no ping-pong. Two mapping rows (plugin-side + Frappe Medusync Mapping) declare the field pairs.

**Tech Stack:** Medusa v2.15.5 (module + MedusaService + event bus + admin extension routes/pages, React + @medusajs/ui + zod), Frappe/ERPNext 16 (Custom Field + Medusync Mapping + doc_events), the generic `medusa-plugin-erpnext` registry engine.

**Testing note (read first):** This is a cross-system integration feature. The meaningful test is the round-trip, so each task's verification runs real HTTP/`bench` assertions (create on side A → assert on side B), consistent with how this connector has been verified throughout. There is no unit-test harness for the module; do not invent one.

**Environment constants (this demo):**
- Sandbox backend: `C:\Users\KillerKoli\Divya\00-medusa\00-medusa\risitex-mainb2b\apps\backend` (henceforth `$B`).
- Generic plugin: `C:\Users\KillerKoli\Divya\00-medusa\00-medusa\000-medusa-plugins&extensions\medusa-plugin-erpnext-generic` (henceforth `$P`); build via the junction `00-medusa/00-medusa/pluginbuild` to dodge the `&`.
- Medusa API `http://127.0.0.1:9000`, admin `http://127.0.0.1:7001/app` (serve-admin.js), admin creds `demo-admin@example.com` / `Demo12345!`.
- Frappe: WSL user `divya`, `/home/divya/frappe-bench`, site `site1.local`, doctype `RISITEX Wallet Settlement`. Run Frappe via a `.sh` file with `MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/…/x.sh` (inline `wsl bash -c` breaks on the `(x86)` PATH).
- WSL clock is UTC (5:30 behind IST).

---

## File Structure

**Create (Medusa sandbox `$B`):**
- `src/modules/wallet_settlement/models/wallet-settlement.ts` — the model.
- `src/modules/wallet_settlement/service.ts` — MedusaService.
- `src/modules/wallet_settlement/index.ts` — module export.
- `src/api/admin/wallet-settlements/route.ts` — GET list, POST create (+emit).
- `src/api/admin/wallet-settlements/[id]/route.ts` — GET one, POST update (+emit), DELETE cancel (+emit).
- `src/admin/routes/wallet-settlements/page.tsx` — admin CRUD page.
- `src/scripts/seed-wallet-settlement-demo.ts` — plugin-side mapping seed.

**Modify:**
- `$B/medusa-config.ts` — register the module.
- `$P/src/modules/erpnext/registry.ts` — add `walletSettlementEntity` + register it.
- `$P/src/admin/routes/erpnext/page.tsx` — add `wallet_settlement` to `ENTITY_DOCTYPE_SUGGESTIONS`.
- `/home/divya/frappe-bench/apps/medusync/medusync/handlers/risitex/mapped.py` — safe-delete → status=Cancelled when the doctype has that status option.

**Frappe data (via bench scripts, created under a temp module in the medusync app):**
- Custom Field: add `Cancelled` to `RISITEX Wallet Settlement.status`.
- Medusync Mapping row `Wallet Settlement ↔ Medusa`.

---

## Task 1: Medusa `wallet_settlement` model + module

**Files:**
- Create: `$B/src/modules/wallet_settlement/models/wallet-settlement.ts`
- Create: `$B/src/modules/wallet_settlement/service.ts`
- Create: `$B/src/modules/wallet_settlement/index.ts`
- Modify: `$B/medusa-config.ts`

- [ ] **Step 1: Write the model**

`$B/src/modules/wallet_settlement/models/wallet-settlement.ts`:
```ts
import { model } from "@medusajs/framework/utils"

/**
 * A wallet settlement batch, mirrored two-way with the ERPNext doctype
 * `RISITEX Wallet Settlement`. Amounts are kept in the SAME unit as
 * ERPNext (rupees) as plain numbers — no paise conversion. `status`
 * uses ERPNext's exact title-case values so no case transform is needed
 * in the mapping. `Cancelled` is the safe-delete state (records are
 * marked, never destroyed).
 */
export const WalletSettlement = model.define("wallet_settlement", {
  id: model.id().primaryKey(),
  settlement_batch_id: model.text().unique(),
  period_from: model.text().nullable(),
  period_to: model.text().nullable(),
  total_credits: model.number().nullable(),
  total_debits: model.number().nullable(),
  net_amount: model.number().nullable(),
  currency: model.text().nullable(),
  status: model
    .enum(["Pending", "Posted", "Failed", "Cancelled"])
    .default("Pending"),
})
```

- [ ] **Step 2: Write the service**

`$B/src/modules/wallet_settlement/service.ts`:
```ts
import { MedusaService } from "@medusajs/framework/utils"
import { WalletSettlement } from "./models/wallet-settlement"

class WalletSettlementService extends MedusaService({ WalletSettlement }) {}

export default WalletSettlementService
```

- [ ] **Step 3: Write the module index**

`$B/src/modules/wallet_settlement/index.ts`:
```ts
import { Module } from "@medusajs/framework/utils"
import WalletSettlementService from "./service"

export const WALLET_SETTLEMENT_MODULE = "wallet_settlement"

export default Module(WALLET_SETTLEMENT_MODULE, {
  service: WalletSettlementService,
})

export { WalletSettlementService }
```

- [ ] **Step 4: Register the module in medusa-config.ts**

In `$B/medusa-config.ts`, inside the `modules: { … }` object (next to `cashfree_wallet`), add:
```ts
    wallet_settlement: {
      resolve: "./src/modules/wallet_settlement",
    },
```

- [ ] **Step 5: Generate + run the migration**

Run (from `$B`):
```bash
./node_modules/.bin/medusa db:generate wallet_settlement && ./node_modules/.bin/medusa db:migrate
```
Expected: a migration file is created under `src/modules/wallet_settlement/migrations/` and applied ("Migrations completed"). If `db:generate` reports "No changes", confirm the module was added to `medusa-config.ts`.

- [ ] **Step 6: Verify the table + service resolve**

Create `$B/src/scripts/probe-ws.ts`:
```ts
import { ExecArgs } from "@medusajs/framework/types"

export default async function probeWs({ container }: ExecArgs) {
  const svc: any = container.resolve("wallet_settlement")
  const [row] = await svc.createWalletSettlements([
    { settlement_batch_id: "PROBE-1", currency: "INR", status: "Pending" },
  ])
  console.log("[probe] created", row.id, row.settlement_batch_id)
  const list = await svc.listWalletSettlements({ settlement_batch_id: "PROBE-1" })
  console.log("[probe] list count", list.length)
  await svc.deleteWalletSettlements([row.id])
  console.log("[probe] deleted OK")
}
```
Run: `./node_modules/.bin/medusa exec ./src/scripts/probe-ws.ts`
Expected: prints "created …", "list count 1", "deleted OK". Then delete the probe script.

- [ ] **Step 7: Commit** (do NOT push)
```bash
git add src/modules/wallet_settlement medusa-config.ts
git commit -m "feat(demo): add wallet_settlement module"
```

---

## Task 2: Admin API routes (create/update/cancel + emit events)

These are the ONLY Medusa-side write path that emits events. Inbound sync writes go through the module service directly (Task 4) and stay silent, preventing loops.

**Files:**
- Create: `$B/src/api/admin/wallet-settlements/route.ts`
- Create: `$B/src/api/admin/wallet-settlements/[id]/route.ts`

- [ ] **Step 1: Write the collection route**

`$B/src/api/admin/wallet-settlements/route.ts`:
```ts
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { z } from "zod"

const WS_MODULE = "wallet_settlement"

const CreateSchema = z.object({
  settlement_batch_id: z.string().trim().min(1),
  period_from: z.string().trim().nullish(),
  period_to: z.string().trim().nullish(),
  total_credits: z.number().nullish(),
  total_debits: z.number().nullish(),
  net_amount: z.number().nullish(),
  currency: z.string().trim().nullish(),
  status: z.enum(["Pending", "Posted", "Failed", "Cancelled"]).default("Pending"),
})

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const svc = req.scope.resolve(WS_MODULE) as any
  const rows = await svc.listWalletSettlements({}, { order: { settlement_batch_id: "ASC" } })
  return res.json({ wallet_settlements: rows })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = CreateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid wallet settlement", errors: parsed.error.flatten() })
  }
  const svc = req.scope.resolve(WS_MODULE) as any
  const [created] = await svc.createWalletSettlements([parsed.data])
  const eventBus = req.scope.resolve(Modules.EVENT_BUS)
  await eventBus.emit({ name: "wallet_settlement.created", data: { id: created.id } })
  return res.status(201).json({ wallet_settlement: created })
}
```

- [ ] **Step 2: Write the item route**

`$B/src/api/admin/wallet-settlements/[id]/route.ts`:
```ts
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { z } from "zod"

const WS_MODULE = "wallet_settlement"

const UpdateSchema = z.object({
  period_from: z.string().trim().nullish(),
  period_to: z.string().trim().nullish(),
  total_credits: z.number().nullish(),
  total_debits: z.number().nullish(),
  net_amount: z.number().nullish(),
  currency: z.string().trim().nullish(),
  status: z.enum(["Pending", "Posted", "Failed", "Cancelled"]).optional(),
})

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const svc = req.scope.resolve(WS_MODULE) as any
  const row = await svc.retrieveWalletSettlement(req.params.id)
  return res.json({ wallet_settlement: row })
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  const parsed = UpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid update", errors: parsed.error.flatten() })
  }
  const svc = req.scope.resolve(WS_MODULE) as any
  const [updated] = await svc.updateWalletSettlements([{ id: req.params.id, ...parsed.data }])
  const eventBus = req.scope.resolve(Modules.EVENT_BUS)
  await eventBus.emit({ name: "wallet_settlement.updated", data: { id: updated.id } })
  return res.json({ wallet_settlement: updated })
}

// Safe delete = mark Cancelled + soft-delete, then emit deleted so the
// far side also cancels. The record is preserved on both sides.
export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
  const svc = req.scope.resolve(WS_MODULE) as any
  await svc.updateWalletSettlements([{ id: req.params.id, status: "Cancelled" }])
  await svc.deleteWalletSettlements([req.params.id])
  const eventBus = req.scope.resolve(Modules.EVENT_BUS)
  await eventBus.emit({ name: "wallet_settlement.deleted", data: { id: req.params.id } })
  return res.json({ id: req.params.id, object: "wallet_settlement", deleted: true })
}
```

- [ ] **Step 3: Verify routes respond (server must be running)**

Run:
```bash
API=http://127.0.0.1:9000
TOKEN=$(curl -s "$API/auth/user/emailpass" -H "Content-Type: application/json" -d '{"email":"demo-admin@example.com","password":"Demo12345!"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
curl -s "$API/admin/wallet-settlements" -H "Authorization: Bearer $TOKEN" -d '{"settlement_batch_id":"API-TEST-1","currency":"INR","total_credits":100,"total_debits":40,"net_amount":60}' -H "Content-Type: application/json"
```
Expected: `{"wallet_settlement":{…"settlement_batch_id":"API-TEST-1"…}}` HTTP 201. (Restart `medusa develop` first if the routes 404 — new API files need a reload.)

- [ ] **Step 4: Commit** (no push)
```bash
git add src/api/admin/wallet-settlements
git commit -m "feat(demo): wallet-settlement admin API routes with event emit"
```

---

## Task 3: Medusa admin CRUD page

**Files:**
- Create: `$B/src/admin/routes/wallet-settlements/page.tsx`

- [ ] **Step 1: Write the page**

`$B/src/admin/routes/wallet-settlements/page.tsx`:
```tsx
import { defineRouteConfig } from "@medusajs/admin-sdk"
import { CurrencyDollar } from "@medusajs/icons"
import {
  Container, Heading, Button, Table, Input, Label, Select, Drawer, toast,
} from "@medusajs/ui"
import { useEffect, useState } from "react"

type WS = {
  id: string
  settlement_batch_id: string
  period_from?: string | null
  period_to?: string | null
  total_credits?: number | null
  total_debits?: number | null
  net_amount?: number | null
  currency?: string | null
  status: "Pending" | "Posted" | "Failed" | "Cancelled"
}

const BLANK: Partial<WS> = { settlement_batch_id: "", currency: "INR", status: "Pending" }

const WalletSettlementsPage = () => {
  const [rows, setRows] = useState<WS[]>([])
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Partial<WS>>(BLANK)
  const [editing, setEditing] = useState<string | null>(null)

  const load = async () => {
    const r = await fetch("/admin/wallet-settlements", { credentials: "include" })
    const b = await r.json()
    setRows(b.wallet_settlements ?? [])
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    const url = editing ? `/admin/wallet-settlements/${editing}` : "/admin/wallet-settlements"
    const body = editing
      ? { period_from: draft.period_from, period_to: draft.period_to, total_credits: draft.total_credits,
          total_debits: draft.total_debits, net_amount: draft.net_amount, currency: draft.currency, status: draft.status }
      : draft
    const r = await fetch(url, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    })
    if (!r.ok) { toast.error("Save failed"); return }
    toast.success(editing ? "Updated" : "Created")
    setOpen(false); setDraft(BLANK); setEditing(null); load()
  }

  const cancel = async (id: string) => {
    const r = await fetch(`/admin/wallet-settlements/${id}`, { method: "DELETE", credentials: "include" })
    if (!r.ok) { toast.error("Cancel failed"); return }
    toast.success("Cancelled"); load()
  }

  const num = (v: string) => (v === "" ? null : Number(v))

  return (
    <Container className="p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading>Wallet Settlements</Heading>
        <Button size="small" onClick={() => { setDraft(BLANK); setEditing(null); setOpen(true) }}>
          Add settlement
        </Button>
      </div>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Batch</Table.HeaderCell>
            <Table.HeaderCell>Period</Table.HeaderCell>
            <Table.HeaderCell>Net</Table.HeaderCell>
            <Table.HeaderCell>Currency</Table.HeaderCell>
            <Table.HeaderCell>Status</Table.HeaderCell>
            <Table.HeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row key={r.id}>
              <Table.Cell>{r.settlement_batch_id}</Table.Cell>
              <Table.Cell>{r.period_from} → {r.period_to}</Table.Cell>
              <Table.Cell>{r.net_amount}</Table.Cell>
              <Table.Cell>{r.currency}</Table.Cell>
              <Table.Cell>{r.status}</Table.Cell>
              <Table.Cell>
                <div className="flex gap-2">
                  <Button size="small" variant="secondary"
                    onClick={() => { setDraft(r); setEditing(r.id); setOpen(true) }}>Edit</Button>
                  <Button size="small" variant="danger"
                    disabled={r.status === "Cancelled"} onClick={() => cancel(r.id)}>Cancel</Button>
                </div>
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      <Drawer open={open} onOpenChange={setOpen}>
        <Drawer.Content>
          <Drawer.Header><Drawer.Title>{editing ? "Edit" : "New"} settlement</Drawer.Title></Drawer.Header>
          <Drawer.Body className="flex flex-col gap-3">
            <div>
              <Label>Batch id</Label>
              <Input value={draft.settlement_batch_id ?? ""} disabled={!!editing}
                onChange={(e) => setDraft((d) => ({ ...d, settlement_batch_id: e.target.value }))} />
            </div>
            <div className="flex gap-2">
              <div><Label>Period from</Label>
                <Input placeholder="2026-08-01" value={draft.period_from ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, period_from: e.target.value }))} /></div>
              <div><Label>Period to</Label>
                <Input placeholder="2026-08-31" value={draft.period_to ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, period_to: e.target.value }))} /></div>
            </div>
            <div className="flex gap-2">
              <div><Label>Credits</Label>
                <Input type="number" value={draft.total_credits ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, total_credits: num(e.target.value) }))} /></div>
              <div><Label>Debits</Label>
                <Input type="number" value={draft.total_debits ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, total_debits: num(e.target.value) }))} /></div>
              <div><Label>Net</Label>
                <Input type="number" value={draft.net_amount ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, net_amount: num(e.target.value) }))} /></div>
            </div>
            <div className="flex gap-2">
              <div><Label>Currency</Label>
                <Input value={draft.currency ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))} /></div>
              <div className="flex-1"><Label>Status</Label>
                <Select value={draft.status ?? "Pending"}
                  onValueChange={(v) => setDraft((d) => ({ ...d, status: v as WS["status"] }))}>
                  <Select.Trigger><Select.Value /></Select.Trigger>
                  <Select.Content>
                    {["Pending", "Posted", "Failed", "Cancelled"].map((s) => (
                      <Select.Item key={s} value={s}>{s}</Select.Item>
                    ))}
                  </Select.Content>
                </Select>
              </div>
            </div>
          </Drawer.Body>
          <Drawer.Footer>
            <Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>
            <Button onClick={save}>{editing ? "Save" : "Create"}</Button>
          </Drawer.Footer>
        </Drawer.Content>
      </Drawer>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "Wallet Settlements",
  icon: CurrencyDollar,
})

export default WalletSettlementsPage
```

- [ ] **Step 2: Typecheck the sandbox admin**

Run (from `$B`): `./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "wallet-settlements|error TS" | head`
Expected: no output (clean). If `@medusajs/icons` has no `CurrencyDollar`, substitute `CurrencyDollarSolid` or `Buildings` (pick one that exists: `grep -o 'CurrencyDollar[A-Za-z]*' node_modules/@medusajs/icons/dist/index.d.ts | head`).

- [ ] **Step 3: Rebuild admin + verify page loads**

Run (from `$B`):
```bash
MEDUSA_BACKEND_URL=http://127.0.0.1:9000 DISABLE_MEDUSA_ADMIN=false ./node_modules/.bin/medusa build --admin-only
```
Then hard-refresh `http://127.0.0.1:7001/app`, confirm a "Wallet Settlements" item appears in the sidebar and the page lists rows / opens the drawer.

- [ ] **Step 4: Commit** (no push)
```bash
git add src/admin/routes/wallet-settlements
git commit -m "feat(demo): wallet settlements admin CRUD page"
```

---

## Task 4: Register the connector entity (generic plugin)

**Files:**
- Modify: `$P/src/modules/erpnext/registry.ts`
- Modify: `$P/src/admin/routes/erpnext/page.tsx`

- [ ] **Step 1: Add the entity descriptor**

In `$P/src/modules/erpnext/registry.ts`, after `fulfillmentEntity` (just before the `// ─── Registry ───` block), add:
```ts
const walletSettlementEntity = genericEntity({
    key: "wallet_settlement",
    label: "Wallet settlement",
    moduleName: "wallet_settlement",
    modelName: "WalletSettlement",
    events: [
        "wallet_settlement.created",
        "wallet_settlement.updated",
        "wallet_settlement.deleted",
    ],
    default_key_path: "settlement_batch_id",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "settlement_batch_id", label: "Batch id", type: "string" },
        { path: "period_from", label: "Period from", type: "string" },
        { path: "period_to", label: "Period to", type: "string" },
        { path: "total_credits", label: "Total credits", type: "number" },
        { path: "total_debits", label: "Total debits", type: "number" },
        { path: "net_amount", label: "Net amount", type: "number" },
        { path: "currency", label: "Currency", type: "string" },
        { path: "status", label: "Status", type: "string" },
    ],
    // Safe delete: mark Cancelled by key, never destroy. Uses the
    // selector form updateWalletSettlements({settlement_batch_id}, {...})
    // — NOT the array-with-id form, which trips the mikro-orm bug (see
    // customer disableByKey).
    disableByKey: async (container, key_field, key_value) => {
        const m: any = container.resolve("wallet_settlement")
        const filter: any = {}
        filter[key_field] = key_value
        await m.updateWalletSettlements(filter, { status: "Cancelled" })
        return { ok: true }
    },
})
```

- [ ] **Step 2: Register it in the REGISTRY map**

In the same file, in `const REGISTRY: Record<string, EntityDescriptor> = { … }`, add after `fulfillment: fulfillmentEntity,`:
```ts
    wallet_settlement: walletSettlementEntity,
```

- [ ] **Step 3: Add the doctype suggestion**

In `$P/src/admin/routes/erpnext/page.tsx`, in `ENTITY_DOCTYPE_SUGGESTIONS`, add:
```ts
  wallet_settlement: ["RISITEX Wallet Settlement"],
```

- [ ] **Step 4: Typecheck the plugin**

Run (from `00-medusa/00-medusa/pluginbuild`): `./node_modules/.bin/tsc --noEmit -p tsconfig.json 2>&1 | grep -E "registry.ts|page.tsx|error TS" | head`
Expected: no output. Confirm `updateWalletSettlements` accepts the selector form `(filter, data)` — the generic customer `disableByKey` in this same file uses the identical shape, so this is consistent.

- [ ] **Step 5: Commit** (no push)
```bash
git -C "$P" add src/modules/erpnext/registry.ts src/admin/routes/erpnext/page.tsx
git -C "$P" commit -m "feat: register wallet_settlement connector entity"
```

---

## Task 5: ERPNext — add `Cancelled` status + safe-delete handler

**Files:**
- Modify: `/home/divya/frappe-bench/apps/medusync/medusync/handlers/risitex/mapped.py`
- Create (temp): a bench script to add the Custom Field.

- [ ] **Step 1: Add `Cancelled` to the status Select via a bench script**

Create `C:\Users\KillerKoli\ws_addstatus.sh`:
```bash
#!/bin/bash
cd /home/divya/frappe-bench
export PATH="$HOME/.local/bin:$PATH"
cat > apps/medusync/medusync/_ws_status.py <<'PY'
import frappe
def run():
    df = frappe.get_doc("DocType", "RISITEX Wallet Settlement")
    for f in df.fields:
        if f.fieldname == "status":
            opts = [o.strip() for o in (f.options or "").split("\n") if o.strip()]
            if "Cancelled" not in opts:
                opts.append("Cancelled")
                f.options = "\n".join(opts)
                df.save(ignore_permissions=True)
                frappe.db.commit()
                print("added Cancelled ->", f.options.replace("\n","/"))
            else:
                print("already present")
            return
    print("no status field")
PY
bench --site site1.local execute medusync._ws_status.run
```
Run: `MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/ws_addstatus.sh`
Expected: prints `added Cancelled -> Pending/Posted/Failed/Cancelled` (or "already present" on re-run). Note: this doctype is app-owned, not custom — editing its DocField options in-place is acceptable for the demo; the value persists in the DB.

- [ ] **Step 2: Verify the option landed**

Append to the same script (or run separately) a get_value on `RISITEX Wallet Settlement` status options — confirm `Cancelled` is present. Expected: the options string contains `Cancelled`.

- [ ] **Step 3: Patch the safe-delete handler**

In `/home/divya/frappe-bench/apps/medusync/medusync/handlers/risitex/mapped.py`, the delete block currently ends with a hard `frappe.delete_doc(...)`. Replace the hard-delete fallback so a doctype whose `status` field offers `Cancelled` is marked instead of destroyed. Change:
```python
		if doc.meta.get_field("disabled"):
			doc.db_set("disabled", 1)
			return {"doctype": doctype, "name": existing, "status": "updated", "action": "disabled"}
		frappe.delete_doc(doctype, existing, ignore_permissions=True)
		return {"doctype": doctype, "name": existing, "status": "updated", "action": "deleted"}
```
to:
```python
		if doc.meta.get_field("disabled"):
			doc.db_set("disabled", 1)
			return {"doctype": doctype, "name": existing, "status": "updated", "action": "disabled"}
		status_field = doc.meta.get_field("status")
		if status_field and "Cancelled" in (status_field.options or "").split("\n"):
			doc.db_set("status", "Cancelled")
			return {"doctype": doctype, "name": existing, "status": "updated", "action": "cancelled"}
		frappe.delete_doc(doctype, existing, ignore_permissions=True)
		return {"doctype": doctype, "name": existing, "status": "updated", "action": "deleted"}
```
Edit the file with the Edit tool (the file is on the Windows-visible WSL path `\\wsl$\…` is unreliable — instead edit via a here-doc patch script if the Edit tool can't reach it; the WSL path from Windows is `/c`-invisible, so use a small python patcher run under bench, mirroring `relax_replay.py`).

- [ ] **Step 4: Reload Frappe to pick up the code change**

The `bench start` watcher reloads on .py change; confirm no traceback in the bench task output after saving. If watch is off, the change is picked up on the next request (dev server reloads modules). No restart required for a handler edit.

- [ ] **Step 5: Commit** — the medusync app has NO git in the demo bench (per project notes). Instead, copy the patched `mapped.py` + a note into `00-medusa/00-medusa/medusync-demo-patches/` so the change is captured for the eventual repo PR. Do not attempt `git` inside the bench.

---

## Task 6: Seed both mapping rows

**Files:**
- Create: `$B/src/scripts/seed-wallet-settlement-demo.ts`
- Create (temp): `C:\Users\KillerKoli\ws_seed_mapping.sh` (Frappe Medusync Mapping)

- [ ] **Step 1: Plugin-side mapping seed**

`$B/src/scripts/seed-wallet-settlement-demo.ts`:
```ts
import { ExecArgs } from "@medusajs/framework/types"

/**
 * Demo-only: plugin-side mapping for wallet_settlement ↔ RISITEX Wallet
 * Settlement (two-way). Mirrors the Product ↔ Item seed shape. Idempotent.
 */
export default async function seed({ container }: ExecArgs) {
  const svc: any = container.resolve("erpnext")
  const existing = await svc.listErpnextMappings({}, { take: 500 })
  const cur = existing.find((m: any) => m.name === "Wallet Settlement ↔ RISITEX Wallet Settlement")
  const row = {
    name: "Wallet Settlement ↔ RISITEX Wallet Settlement",
    enabled: true,
    medusa_entity: "wallet_settlement",
    doctype: "RISITEX Wallet Settlement",
    direction: "both",
    events: ["wallet_settlement.created", "wallet_settlement.updated", "wallet_settlement.deleted"],
    key_medusa_field: "settlement_batch_id",
    key_erpnext_field: "settlement_batch_id",
    allow_create: true,
    allow_update: true,
    field_mappings: [
      { medusa_path: "settlement_batch_id", erpnext_field: "settlement_batch_id", direction: "both" },
      { medusa_path: "period_from", erpnext_field: "period_from", direction: "both" },
      { medusa_path: "period_to", erpnext_field: "period_to", direction: "both" },
      { medusa_path: "total_credits", erpnext_field: "total_credits", direction: "both" },
      { medusa_path: "total_debits", erpnext_field: "total_debits", direction: "both" },
      { medusa_path: "net_amount", erpnext_field: "net_amount", direction: "both" },
      { medusa_path: "currency", erpnext_field: "currency", direction: "both" },
      { medusa_path: "status", erpnext_field: "status", direction: "both" },
      { medusa_path: "id", erpnext_field: "medusa_settlement_id", direction: "push" },
    ],
  }
  if (cur) { await svc.updateErpnextMappings([{ id: cur.id, ...row }]); console.log("[seed] updated") }
  else { await svc.createErpnextMappings([row]); console.log("[seed] created") }
}
```
Run: `./node_modules/.bin/medusa exec ./src/scripts/seed-wallet-settlement-demo.ts`
Expected: `[seed] created`.

- [ ] **Step 2: Frappe Medusync Mapping seed**

Create `C:\Users\KillerKoli\ws_seed_mapping.sh`:
```bash
#!/bin/bash
cd /home/divya/frappe-bench
export PATH="$HOME/.local/bin:$PATH"
cat > apps/medusync/medusync/_ws_seed.py <<'PY'
import frappe
def run():
    name = "Wallet Settlement to Medusa"
    if frappe.db.exists("Medusync Mapping", name):
        print("exists"); return
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
        "direction": "Both",
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
```
Run: `MSYS_NO_PATHCONV=1 wsl -u divya -- bash /mnt/c/Users/KillerKoli/ws_seed_mapping.sh`
Expected: `created Wallet Settlement to Medusa`. (If `direction` rejects "Both", check the Select options with a get_value on DocField and use the exact allowed value — likely `Both`.)

- [ ] **Step 3: Verify both mappings exist**

Plugin: `curl -s "$API/admin/erpnext/mappings" -H "Authorization: Bearer $TOKEN"` → contains the wallet mapping.
Frappe: re-run a get_list on Medusync Mapping → `Wallet Settlement to Medusa` present.

- [ ] **Step 4: Commit the Medusa-side seed** (no push)
```bash
git -C "$B" add src/scripts/seed-wallet-settlement-demo.ts && git -C "$B" commit -m "feat(demo): seed wallet_settlement plugin mapping"
```
Capture the Frappe seed script into `00-medusa/00-medusa/medusync-demo-patches/`.

---

## Task 7: Build, wire, and end-to-end verification

- [ ] **Step 1: Rebuild the plugin + copy + rebuild admin**

Run:
```bash
cd "/c/Users/KillerKoli/Divya/00-medusa/00-medusa/pluginbuild" && ./node_modules/.bin/medusa plugin:build
SRC="/c/Users/KillerKoli/Divya/00-medusa/00-medusa/pluginbuild/.medusa"
DST="/c/Users/KillerKoli/Divya/00-medusa/00-medusa/risitex-mainb2b/node_modules/medusa-plugin-erpnext/.medusa"
rm -rf "$DST" && cp -r "$SRC" "$DST"
cd "/c/Users/KillerKoli/Divya/00-medusa/00-medusa/risitex-mainb2b/apps/backend" && MEDUSA_BACKEND_URL=http://127.0.0.1:9000 DISABLE_MEDUSA_ADMIN=false ./node_modules/.bin/medusa build --admin-only
```
Expected: both builds report success.

- [ ] **Step 2: Restart the demo Medusa backend** (so the new module, routes, and copied plugin load). Kill the running `medusa develop` for the sandbox ONLY (path contains `00-medusa\risitex-mainb2b`; do NOT kill the `D:\…\risitex-main` processes), then start it again and wait for "Server is ready". Also confirm serve-admin (:7001) and the bench (:8000) are up.

- [ ] **Step 3: E2E — Medusa → ERPNext (create)**

```bash
curl -s "$API/admin/wallet-settlements" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"settlement_batch_id":"E2E-M2E-1","period_from":"2026-08-01","period_to":"2026-08-31","total_credits":500,"total_debits":200,"net_amount":300,"currency":"INR","status":"Pending"}'
```
Then (bench) get the `RISITEX Wallet Settlement` named `E2E-M2E-1`.
Expected: exists, `net_amount=300`, `medusa_settlement_id` populated.

- [ ] **Step 4: E2E — ERPNext → Medusa (create)**

Create a `RISITEX Wallet Settlement` in ERPNext (bench `frappe.get_doc(...).insert()`) with `settlement_batch_id="E2E-E2M-1"`, amounts, `status="Posted"`.
Then `curl -s "$API/admin/wallet-settlements" …` and grep for `E2E-E2M-1`.
Expected: present in Medusa with matching figures and `status="Posted"`.

- [ ] **Step 5: E2E — edit both ways**

Edit `E2E-M2E-1` amount via `POST /admin/wallet-settlements/{id}` → assert the ERPNext doc's amount changes. Edit `E2E-E2M-1` status in ERPNext → assert the Medusa row's status changes.

- [ ] **Step 6: E2E — cancel (safe delete) both ways**

`DELETE /admin/wallet-settlements/{id}` for E2E-M2E-1 → assert the ERPNext doc still EXISTS with `status="Cancelled"`. Cancel `E2E-E2M-1` in ERPNext (`on_trash` or set status) → assert the Medusa row still exists with `status="Cancelled"`.
Expected: no row destroyed on either side; both marked Cancelled.

- [ ] **Step 7: Regression — Customer + Item still sync**

Create a Customer in Medusa with a fresh email → assert it lands in ERPNext (as in the existing verified flow). Confirms the new entity didn't disturb the registry/subscriber.

- [ ] **Step 8: Clean up test rows + probe scripts**, and record results in `00-medusa/00-medusa/WALLET_SETTLEMENT_RESULTS.md` (PASS/FAIL matrix for the six E2E checks + regression).

---

## Self-review notes
- **Spec coverage:** module (T1), events (T2), admin page/both-editable (T3), entity + safe-delete disableByKey (T4), Cancelled status + handler (T5), both mappings seeded (T6), E2E incl. cancel-not-destroy + regression (T7). All spec sections covered.
- **Type consistency:** `wallet_settlement` module key, `WalletSettlement` model key → `list/create/update/deleteWalletSettlements`; status values title-case (`Pending/Posted/Failed/Cancelled`) identical across model, routes, page, entity, and mappings (no case transform). Key field `settlement_batch_id` identical across model (`.unique()`), entity `default_key_path`, and both mappings.
- **Open risk flagged for implementation:** editing the WSL-resident `mapped.py` from Windows tools — use a python patcher run under bench (like `relax_replay.py`), not a direct Edit, if the `\\wsl$` path isn't reachable. And confirm the Medusync Mapping `direction` Select accepts `Both` before seeding (Step 6.2).
