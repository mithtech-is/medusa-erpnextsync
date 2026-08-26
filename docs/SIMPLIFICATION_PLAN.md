# ERPNext connector simplification plan (plugin + medusync)

Goal: make the connector a clean, **business-neutral, mapping-driven** pair.
No Polemarch/Mithtech domain logic in either side's core; any domain logic
lives in an optional, clearly-quarantined pack that prod still depends on.

## What's already generic (keep as-is)

- **Plugin outbound** — both the full push (`{event,id,data}` → `medusync.api.receive`)
  and the mapped push (`{…,doctype,key_field,key_value,payload}` → `…receive_mapped`)
  are mapping/event-neutral. Endpoint is configurable (`frappe_receive_method`).
- **Plugin pull cron** — mapping-driven (`applyMapping(pull)` → registry `upsertByKey`).
- **Plugin mapping engine + canonical-mappings** — generic; one neutral starter.
- **medusync core (~1,250 LOC)** — `Medusync Settings/Mapping/Field Map/Log`
  doctypes, wildcard `doc_events` → mapping-driven outbound, generic
  `apply_inbound`. Already domain-free.

## The wire contract (already matched — do not break)

| Direction | Endpoint / target | Body | HMAC header | Secret pairing |
|---|---|---|---|---|
| Medusa→Frappe (full) | `…/api/method/medusync.api.receive` | `{event,id,data}` | `x-medusa-signature` (hex) + `x-medusa-event-id` | plugin `webhook_secret` = medusync `inbound_secret` |
| Medusa→Frappe (mapped) | `…receive_mapped` | `{event,id,mapping_id,mapping_name,doctype,key_field,key_value,payload,allow_create,allow_update}` | same | same |
| Frappe→Medusa | plugin `POST /webhooks/erpnext-inbound` | `{event,event_id,data}` | `x-medusa-signature` / `x-frappe-webhook-signature` | medusync `outbound_secret` = plugin `frappe_to_medusa_secret` |

## The gap

The **plugin's inbound receiver** (`dispatchInbound` + all `_handle*`) is the one
path that does NOT use the mapping engine — it's a hardcoded `switch(event)` over
Polemarch events with hardcoded Frappe field names (`custom_kyc_*`,
`custom_client_id`, `polemarch_page_url`, bank/demat children, rupee→paise,
`currency_code:"inr"`). medusync's outbound is already generic, so the plugin
inbound is the mismatch.

Plus three bounded cleanups: a redundant Frappe-Webhook seeder, dead code, and
one import leak on the medusync side.

---

## Plugin changes (`medusa-plugin-erpnext-generic`)

1. **Make the inbound receiver mapping-driven.** Replace `dispatchInbound` + every
   `_handle*` handler with the same logic the pull cron already uses: resolve the
   plugin mapping(s) whose events match the inbound `event` (or whose `doctype`
   matches), run `applyMapping(pull)` to translate `data` → Medusa payload, and
   upsert via the registry entity's `upsertByKey`. `.deleted`/`.canceled` events →
   delete/inverse where the registry supports it. Unknown event with no matching
   mapping → 200 skipped (unchanged). This unifies inbound + pull onto one path
   and deletes ~600 lines of Polemarch handlers.
2. **Delete `frappe-webhooks.ts` + the `seed-frappe-webhooks` route + its admin
   button.** medusync configures Frappe→Medusa via `Medusync Mapping` rows +
   wildcard `doc_events`; seeding native Frappe `Webhook` docs from the plugin is
   the old approach and is now redundant. (Decision point — see below.)
3. **Delete dead code** `getSyncMapping`/`saveSyncMapping` (the only
   `"Polemarch Sync Mapping"` reference; zero callers).
4. Result: **zero Polemarch strings** in the plugin; `npx tsc --noEmit` green.

## medusync changes (`frappe16/apps/medusync`)

5. **`receive_mapped`: drop the domain import.** Replace the hardcoded
   `handlers.polemarch.order.upsert_via_mapping(...)` (`api.py:299`) with the
   generic `apply_inbound`-style upsert. Removes the only Polemarch coupling in
   the core `api.py`.
6. **Make the Polemarch pack opt-in.** `install.py after_install` currently
   auto-calls `handlers.polemarch.register()`. Gate it (Settings flag or separate
   `bench execute` step) so a fresh install is domain-free. Move the custom-field
   patch (`install_medusa_reference_fields.py`) into the pack.
7. **Quarantine, do NOT delete, `handlers/polemarch/`.** Polemarch prod depends on
   this wallet/KYC/order logic. Keep it as an optional pack (or a separate app);
   core medusync becomes domain-free without losing prod behavior.

## Verification

- Plugin: `npx tsc --noEmit` (green today; keep it green).
- medusync: `python -m py_compile` on changed files; run `selftest.py` /
  `selftest_delivery.py`; `bench build` if a bench is available.
- Round-trip smoke test against the `risitex-mainb2b` sample store (install
  plugin, point at a medusync-enabled Frappe site, push a customer, confirm a
  mapping round-trips both ways). Document steps in AGENTS.md.

## Decisions to confirm before executing

- **D1 — Drop the plugin's Frappe-Webhook seeder?** Yes = medusync's Medusync
  Mapping rows become the single source of truth for Frappe→Medusa. (Recommended;
  the seeder is Polemarch-shaped and redundant with medusync.) No = keep a
  generic seeder driven from plugin mappings.
- **D2 — Polemarch pack: detach vs. extract to separate app?** Recommend detach
  in place (opt-in) first; extracting to its own app is a larger follow-up.
- **D3 — Inbound delete semantics.** Confirm registry `upsertByKey` should gain a
  matching delete for `.deleted` events, or whether inbound deletes are ignored.
