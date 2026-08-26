# 00-medusa — Medusa plugin/extension workbench

A sandbox for building and testing **reusable, business-agnostic** Medusa v2
plugins and extensions against a real sample store. Inherits the workspace rules
at the Coding-workspace root (`../CLAUDE.md`, if this folder lives under it);
this file adds what's specific to this folder.

**Moving this folder to another machine?** See [SETUP.md](SETUP.md) — node_modules
must be reinstalled (not copied), and **medusync (the Frappe side) is not in this
folder** and must be fetched separately.

## Layout

```
00-medusa/
├── 000-medusa-plugins&extensions/     # the plugins/extensions under development
│   └── medusa-plugin-erpnext-generic/ # generic ERPNext↔Frappe sync (the one we maintain)
└── risitex-mainb2b/                    # sample Medusa site to install/test against
```

- **`medusa-plugin-erpnext-generic`** — package name `medusa-plugin-erpnext`
  (unscoped, v0.1.0). The genericized connector, and the only ERPNext plugin we
  maintain. (A legacy `@mithtech-is/…` port and a Polemarch copy vendored inside
  risitex were both removed 2026-08-24.)
- **`risitex-mainb2b`** — a Mithtech `mithtech-is/risitex-mainb2b` turbo/pnpm
  monorepo (its own git remote). This is the sample store: install the plugin
  here to exercise it end-to-end. Treat it as a consumer, not a place to hide
  plugin logic. Its old vendored `packages/medusa-plugin-erpnext` copy was
  removed (staged in risitex git); wire the generic plugin in when testing.

## The two sides of the ERPNext connector

The connector is **two halves that must stay in sync**:

1. **Medusa side** — `medusa-plugin-erpnext-generic` (here).
2. **Frappe side** — the **`medusync`** Frappe app (`frappe16/apps/medusync`).

They talk over HMAC-signed webhooks (`x-medusa-signature`, sha256 over the raw
body). The Medusa→Frappe target is **configurable**, not hardcoded:

- Setting `frappe_receive_method` (admin UI: ERPNext Sync → Connection), or env
  `ERPNEXT_RECEIVE_METHOD`. Default: `medusync.api.receive`. The mapped-push
  variant appends `_mapped` → `medusync.api.receive_mapped`.

When you change the wire format on one side, change the other. A field renamed
in medusync's `api.receive` envelope but not in the plugin's push (or vice
versa) fails only at runtime.

## Generic plugin — what "generic" means here

The plugin must install cleanly into **any** Medusa v2 store. Hold the line:

- **No business branding** in package identity, UI copy, comments, or examples.
  No "Polemarch", no client names, no hardcoded prod hosts (use `*.example.com`).
- **No hardcoded Frappe app name.** Always derive the receive path from the
  `frappe_receive_method` setting. Never re-introduce a `polemarch.api.*` literal.
- **Entity registry ships only built-in Medusa entities** (customer, order,
  product, cart, region, …). Custom-module entities are opt-in per project via
  the admin editor / seed — don't hardcode a customer's proprietary modules
  (wallet, kyc, calcula, …) back into `registry.ts` or `canonical-mappings.ts`.
- **Canonical mappings are neutral examples** (one Customer↔Customer starter
  against standard ERPNext fields). Not a contract.
- **`npm run typecheck` must pass** before you call a change done
  (`cd medusa-plugin-erpnext-generic && npx tsc --noEmit`). Dependencies are
  already installed there.

## Known remaining work (both sides need simplifying)

The plugin's **surface** is generic (package, endpoint config, entity catalog,
branding). Deeper handlers are still Polemarch-shaped and should be simplified
**in tandem with medusync** so the wire contract matches:

- **Inbound receiver** (`modules/erpnext/index.ts`, `receiveInbound`) hardcodes
  Frappe custom-field names (`custom_kyc_*`, `custom_client_id`,
  `custom_is_mithtech_only`, `is_polemarch_customer`, …) instead of applying the
  configured mapping. Make it mapping-driven.
- **`frappe-webhooks.ts`** seeds Frappe Webhook rows with Polemarch doctypes /
  `polemarch_page_url` template fields.
- **`"Polemarch Sync Mapping"`** Single-doctype name (index.ts, mapping
  pull/push) is a Frappe-side contract. Neutralize it and define the matching
  doctype in medusync.
- Dormant wallet/KYC event routing in the inbound receiver and forwarder.

**medusync** (the Frappe app) should be simplified to the same neutral contract.
Note the workspace boundary rule: `frappe*/apps/*` is normally read-only for
agents — confirm medusync's canonical repo and that editing it is in-scope
before rewriting it (it is Mithtech-owned, likely has a standalone repo).

## Working here

- Per-plugin install/build/typecheck lives in each plugin's own `package.json`.
- To test in the sample store, install the plugin into `risitex-mainb2b` and
  wire it in that store's `medusa-config.ts` — don't couple the plugin to
  risitex internals.
- Keep Polemarch and Mithtech concerns out of shared plugin code. This is shared
  tooling; it must not assume either business's data model or compliance surface.
