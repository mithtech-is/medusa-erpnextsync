# medusa-plugin-erpnext

Bidirectional **ERPNext (Frappe) ↔ Medusa v2** sync, as a Medusa plugin.

- **Push** — customers / orders / products / custom events forwarded over the
  live event bus, with an admin replay surface.
- **Pull** — read-only Frappe REST proxy for previewing remote doctypes, plus
  reconciliation jobs.
- **Mapping engine** — configurable doctype field mappings, triggers, and an
  admin console (ERPNext Sync in the Medusa admin).

The Frappe counterpart is the **`medusync`** app. The plugin is business-neutral:
its entity registry ships only built-in Medusa entities, and the Frappe endpoint
is configurable — point it at any Frappe app.

## Install

```bash
npm install medusa-plugin-erpnext
```

Register it in `medusa-config.ts` under `plugins`, then run migrations
(`medusa db:migrate`). See the Medusa plugin docs for the standard wiring.

## Configure

Admin: **ERPNext Sync → Connection**, or env fallbacks:

| Setting | Env fallback | Default | Purpose |
|---|---|---|---|
| `erpnext_url` | `ERPNEXT_URL` | — | Base URL of the Frappe site |
| `frappe_receive_method` | `ERPNEXT_RECEIVE_METHOD` | `medusync.api.receive` | Whitelisted Frappe method that receives pushes (mapped push appends `_mapped`) |
| `webhook_secret` | `ERPNEXT_WEBHOOK_SECRET` | — | HMAC secret for Medusa→Frappe pushes |
| `frappe_to_medusa_secret` | — | — | HMAC secret for Frappe→Medusa pushes |

Both sides must share the webhook secret, or HMAC verification rejects every
push.

## Develop

```bash
npm run build       # medusa plugin:build
npm run typecheck   # tsc --noEmit
```

## Notes

- Entity registry contains only built-in Medusa entities. Add project-specific
  entities/mappings through the admin editor or by extending `registry.ts` in a
  fork — keep this package generic.
- Canonical mappings ship one neutral `Customer ↔ Customer` starter; edit field
  pairs to match your Frappe instance.
- License: UNLICENSED (private).
