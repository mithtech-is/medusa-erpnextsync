# Medusync ↔ Medusa — implementation plan (demo, end-to-end)

**Goal:** run the demo Medusa store and the demo ERPNext live, and prove the sync
works both directions for **create / read / update / delete / cancel** on Customer,
Product, and Order — with no errors, safe delete semantics, a simple admin UI for
non-technical users, and tight webhook security.

**Working mode:** checkpoint after each phase. This plan is presented for approval
**before any building starts.**

## Guardrails (what I will and won't touch)

**Allowed to change (demo only):**
- `00-medusa/000-medusa-plugins&extensions/medusa-plugin-erpnext-generic/` — the generic Medusa plugin.
- `medusync` Frappe app in the WSL bench: `/home/divya/frappe-bench/apps/medusync/`.
- `00-medusa/00-medusa/risitex-mainb2b/apps/backend/` **config only** (`.env`, `medusa-config.ts` `plugins[]`) to wire + run the demo store. **No git commits to the sandbox.**

**Never touch:**
- The real risitex repo at `D:\Users\KillerKoli\Downloads\risitex-main (1)` (this session's cwd), `Divya/risitex`, `Divya/risitexbackup`, or any risitex git remote.

## Where the demo lives

| Piece | Location | Port |
|---|---|---|
| Demo ERPNext (Frappe bench) | WSL: `/home/divya/frappe-bench` (site `site1.local`), user `divya`; Windows: `\\wsl.localhost\Ubuntu\home\divya\frappe-bench` | 8000 |
| medusync (Frappe app) | `…/frappe-bench/apps/medusync` | — |
| Demo Medusa store (sandbox) | `00-medusa/00-medusa/risitex-mainb2b/apps/backend` | 9000 |
| Generic plugin | `00-medusa/000-medusa-plugins&extensions/medusa-plugin-erpnext-generic` | — |
| Postgres / Redis (Docker, already up) | `risitex-postgres` :5435, `risitex-redis` :26379 | — |

---

## Phase A — Make it sync (create/read/update/delete/cancel, both ways)

### A0. Bring both stacks up
1. ERPNext bench: already running this session; make it durable.
2. Demo Medusa store: `pnpm install`; write `apps/backend/.env` (DATABASE_URL→:5435, REDIS_URL→:26379, generated JWT_SECRET/COOKIE_SECRET, ERPNext plugin settings + secrets that **match** medusync's `inbound_secret`/`outbound_secret`); run migrations; `medusa develop` on :9000.
3. **Coexistence:** on the demo ERPNext site both `medusync` and `risitex_erp` are installed and hook the same doctypes. I'll disable `risitex_erp`'s outbound on the demo site (demo-config only) so **only medusync** drives the sync and results are unambiguous.
4. **Risk / fallback:** the sandbox is a heavy ~30-module B2B backend. If it won't boot within reasonable effort (missing secrets, migration drift, OOM), I'll stop and check with you before falling back to a minimal Medusa store.

### A1. Fix the three blockers (found in this session's verification)
1. **Plugin: push order line items.** Add the Sales-Order/Invoice augmentation to `pushViaMapping` — attach `medusa_items[]`, `medusa_customer_id`, `contact_email`, convert paise→rupees. (Generic plugin folder.)
2. **Plugin: generic inbound receiver.** Make the Frappe→Medusa receiver mapping-driven for the demo entities (customer/product/order) instead of the hardcoded Polemarch handlers, so it consumes medusync's `{event,event_id,data}` correctly. (Generic plugin folder.)
3. **medusync: keep the 2 fixes** already applied this session (log `action` Select; Sales-Order key), and add **safe delete semantics** (below). (medusync app.)

### A2. Safe delete / cancel semantics (your choice: disable/cancel, never destroy)
- Medusa **delete/cancel** → ERPNext: disable Customer, disable/deactivate Product (Item), **cancel** Sales Order (submitted docs can't be hard-deleted). Sales Invoices are never destroyed.
- ERPNext **cancel/disable** → Medusa: soft-equivalent (customer disabled, product unpublished, order canceled).
- Both encoded as `.deleted`/`.canceled` events routed through the mapping engine.

### A3. Configure mappings + secrets
- Create `Medusync Mapping` rows (Customer, Product, Order) with correct directions, key fields, and field maps; pair `inbound_secret`/`outbound_secret` on both sides; point `medusa_url` at the real demo Medusa (:9000, not Frappe's socketio).

### A4. Run the full matrix (evidence for every cell)
For **Customer, Product, Order**, both directions:

| Op | Medusa → ERPNext | ERPNext → Medusa |
|---|---|---|
| Create | ✅ verify doc created | ✅ verify record created |
| Read/Pull | pull cron applies mapping | inbound webhook applies mapping |
| Update | field change propagates | field change propagates |
| Delete | → disable/cancel (A2) | → soft-equivalent (A2) |
| Cancel (Order) | SO cancelled | order canceled |

Plus edge cases: idempotency (retry = no dup), loop-prevention (no ping-pong), guest order skipped, HMAC bad-sig rejected.

**Checkpoint A deliverable:** a filled PASS/FAIL matrix with evidence (doc ids, HTTP codes, screenshots), and a list of anything still failing.

---

## Phase B — Admin-friendly UI (guided + plain language) — *outline, detailed at checkpoint B*
- **Frappe side (medusync):** turn `Medusync Mapping`/`Settings` into plain-language forms — friendly labels, inline help, a guided "add a field mapping" flow, advanced options collapsed, a one-click "Test connection".
- **Medusa side (plugin admin):** same treatment for the ERPNext Sync admin page — connection test, a readable mapping list, and a step-by-step "map a field" wizard.
- **Field-adding UX** is the centrepiece: pick a Medusa entity → pick an ERPNext doctype → map fields from dropdowns (no code), with a live preview.

## Phase C — Security & no link leakage — *outline, detailed at checkpoint C*
- Webhook endpoints: keep HMAC-SHA256 over raw body; add a **replay window** (reject stale `event_id`/timestamps), and confirm the `allow_guest` receivers reject everything without a valid signature.
- **Secrets:** never rendered in the admin UI or logs; rotation supported; not in URLs/query strings.
- **Transport:** enforce HTTPS + `verify_ssl` for prod; localhost only in demo.
- **Rate-limiting / abuse:** basic throttle on the receive endpoints.
- **Audit:** log redaction (`log_payloads` off by default in prod), and a short written security review of the endpoints for leakage.

---

## Open items to confirm
- **Publishing the fixes:** the working medusync code (incl. the risitex handler) currently lives only in the git-less bench. Committing it belongs in the **`suparikoli/medusync`** repo, not risitex. I'll only commit/push on your explicit go-ahead, and never to a risitex remote.
