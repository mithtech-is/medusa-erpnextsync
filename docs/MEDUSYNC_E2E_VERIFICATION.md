# Medusync ↔ Medusa end-to-end verification (demo ERPNext)

**Date:** 2026-08-24
**Tested against:** WSL Frappe/ERPNext 16.22 bench (`site1.local`), the `medusync`
Frappe app installed there, driven with real HMAC-signed HTTP.
**Repo under review:** `github.com/suparikoli/medusync` + the generic
`medusa-plugin-erpnext` in `00-medusa/000-medusa-plugins&extensions/`.

## TL;DR verdict

The Frappe side (`medusync`) **works after two small fixes**, but **the code that
actually works is NOT what's in the GitHub repo**, and **the generic Medusa plugin
is not yet capable of a full order round-trip** (no line-item push, Polemarch-shaped
inbound). Do **not** deploy the repo as-is to RISITEX. The gaps below must close
first. Think of this as "the hard Frappe-side logic is proven correct; the plugin
side and the packaging still need work" — not "ready to install".

| Leg | Status | Evidence |
|---|---|---|
| Medusa → Frappe: Customer push (`receive_mapped`) | ✅ after fix | Customer created, gstin set, idempotent repost = "already applied" |
| Medusa → Frappe: Item/Product push | ✅ after fix | Item created with `item_group=Products`, `stock_uom=Nos`, Item Price ₹499 |
| Medusa → Frappe: Sales Order — **Frappe side** | ✅ after fix | `SAL-ORD-2026-00015`, customer resolved, 3×₹499 = **₹1497** correct, keyed, retry updates (no duplicate) — **given a correctly-augmented envelope** |
| Medusa → Frappe: Sales Order — **generic plugin side** | ❌ | The generic plugin's push does **not** send `medusa_items[]`/`medusa_customer_id`; a real order push would hit `"no valid line items for Sales Order"` |
| HMAC auth (both endpoints) | ✅ | bad signature → 401; valid → 200 |
| Frappe → Medusa: outbound mechanism | ✅ (mechanism) | Item change → 1 signed POST to `/webhooks/erpnext-inbound`, valid HMAC, correct event-id + payload |
| Frappe → Medusa: as configured on the demo | ❌ not wired | **0 Medusync Mapping rows**; `medusa_url` points at Frappe's own socketio (:9000), Medusa backend not running |
| Medusa plugin **inbound** receiver | ❌ incomplete | Still Polemarch-shaped (hardcoded `custom_kyc_*` etc.) — won't consume medusync's generic `{event,event_id,data}` payload |

## The two bugs found (both blocked Medusa→Frappe before the fix)

**Bug 1 — `receive_mapped` writes an invalid Select value → every mapped push HTTP 417.**
`api.py` did `_close(log, ..., action=f"{mapping_name} | {_result_action(result)}")`,
producing `"(unnamed) | created"`. `Medusync Log.action` is a Select allowing only
`"" / created / updated / deleted / skipped`, so it raised `ValidationError` **after**
the business doc had already committed. Effect: docs got written, but the API
returned **417**, the inbound log was stuck at **Queued** (idempotency never
recorded), so the Medusa plugin would see failure and **retry forever**.
➡ **This bug is in GitHub HEAD too (api.py line ~323).** It affects any site, not
just RISITEX — the published `receive_mapped` can never return success.
Fix applied: `action=_result_action(result)`.

**Bug 2 — new Sales Orders were not keyed → duplicate on every retry.**
`handlers/risitex/mapped.py::_upsert_sales_doc` never set the mapping key field
(`medusa_order_id`) on newly-created sales docs, so lookups by key always missed
and every retry created a **new** Sales Order (first run left `SAL-ORD-2026-00014`
with `medusa_order_id=None`). Fix applied: stamp `key_field=key_value` on insert.
➡ This handler is **RISITEX-specific and only exists in the WSL bench** — it is
**not in the GitHub repo** (see next section).

Both fixes live only in the demo bench (`.bak-*` backups next to each file). They
are **not committed anywhere** and must be carried into whatever Frappe app ships
to RISITEX prod.

## The big structural gap: the repo ≠ the working code

- GitHub `medusync` HEAD ships **only `handlers/polemarch/`** (a securities model:
  wallet/KYC/security-sale). Its `receive_mapped` imports
  `handlers.polemarch.order.upsert_via_mapping`.
- The **working RISITEX path** is `handlers/risitex/mapped.py` (Item / Sales Order
  with line items / textile Customer) + a one-line `api.py` change to import it.
  **This exists only in the WSL bench, not in the published repo.**
- So `bench get-app https://github.com/suparikoli/medusync` on a fresh site would
  route RISITEX orders through the Polemarch securities handler (wrong) **and**
  hit Bug 1. It would not work for textile commerce out of the box.

## What still needs doing before RISITEX go-live

1. **Publish the working code.** Commit `handlers/risitex/mapped.py` + the `api.py`
   import + both bug fixes to the medusync repo (or vendor the app). Right now the
   only working copy is an uncommitted bench folder with no git.
2. **Finish the Medusa plugin's inbound receiver.** It's still Polemarch-shaped;
   make it mapping-driven so it can consume medusync's generic `{event,event_id,data}`
   webhooks (this is exactly the `00-medusa/SIMPLIFICATION_PLAN.md` item 1). Until
   then, Frappe→Medusa payloads won't map correctly for RISITEX.
2b. **Port the order-line augmentation into the generic plugin (Medusa→Frappe).**
   The generic plugin's `pushViaMapping` (`modules/erpnext/index.ts:2939`) sends only
   flat mapped fields — it has **no** `medusa_items[]` / `medusa_customer_id` /
   contact_email, and no paise→rupees conversion on order lines (grep of `src/` is
   empty). The Frappe `_upsert_sales_doc` needs those, so a real Sales Order push
   would fail with `"no valid line items"`. This augmentation existed in the *old
   vendored* risitex plugin (since removed) and was never carried into the generic
   one. Verified end-to-end on the Frappe side only, by hand-crafting the envelope.
3. **Configure the site.** Create `Medusync Mapping` rows (none exist), point
   `medusa_url` at the real Medusa backend (it currently points at Frappe's own
   socketio port), pair `inbound_secret`/`outbound_secret` with the plugin.
4. **Decide app coexistence.** Both `risitex_erp` (the older, already prod-verified
   Frappe app) and `medusync` are installed on the demo site and both hook the same
   doctypes. Ship exactly **one** Frappe app to prod, not both.
5. **Verify against the client's real ERPNext v15** (demo is v16.22). Transport is
   version-agnostic; the Item/Sales Order field requirements were cross-checked as
   v15-valid, but run the round-trip on the actual site before cutover.

## How it was tested (reproducible)

- Signed `receive_mapped` envelopes POSTed to `http://127.0.0.1:8000/api/method/medusync.api.receive_mapped`
  with `X-Medusa-Signature = hex HMAC-SHA256(body, inbound_secret)`.
- Outbound proven with a stub HTTP listener on :9010, a temporary `To Medusa`
  mapping on `Item` (a doctype `risitex_erp` does not hook, to avoid double-fire),
  then settings/mapping restored.
