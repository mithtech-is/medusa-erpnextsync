# Decommissioning medusync (Phase 4)

The bespoke Frappe app `medusync` is no longer used by this plugin: ERPNext → Medusa runs on
Frappe core Webhooks and the `medusa_sync` field (0.2.0), Medusa → ERPNext on plain REST (0.3.0),
stock and prices on Webhooks and the Bin (0.4.0). Every site that still has the app installed
keeps running its hooks for nothing — and in the way: its `doc_events["*"]` outbound hook and
`invoicing.guard_store_series` fire on every save, its `Medusync Log` rows link to documents
(an Item Price it logged cannot be deleted while the log row exists), and its scheduler retries
deliveries every minute.

**Uninstalling is per site and needs a yes for that site. Nothing here runs on its own.**

## What medusync leaves on a site

- DocTypes (module *Medusync*): Settings (Single), Site, Site Selection, Selection Doctype,
  Inclusion, Exclusion, Mapping, Field Map, Link, Log, Price List Map, Warehouse Map, Reset
  Request. `bench uninstall-app` drops them and their rows.
- Custom fields: **none of its own on business doctypes** (`install.py` says so). In
  "chosen" selection mode it adds a `medusync_tab` Tab Break and a `medusync_sync` Check to the
  selected doctypes; `remove()` in `sync_field.py` takes them off, and uninstall does too.
  Our `<DocType>-medusa_sync` Select is a different field and stays.
- Hooks: `doc_events["*"]` (outbound, sync tick, store-series guard), scheduler `retry_due`
  every minute, `prune_logs` and `drift.run` daily. All gone with the app.
- On the Medusa side nothing: 0.2.0 already dropped the medusync columns and routes.

Counts on fixerp (2026-09-26): Medusync Log 240, Site 1, Inclusion 29.

## Per site, in this order

1. **Confirm the plugin talks to the site without medusync**: Settings → Test connection,
   Set up ERPNext report all green, one webhook delivery in the Events tab, one push (or a
   rehearsal) green. For production this is the deploy of Splendx on ≥ 0.3.0.
2. **Switch the app off first**: Medusync Settings → Enable Sync off. Watch a day if the site
   is production; nothing should change on the Medusa side.
3. **Keep what you want from the log** (optional): export Medusync Log to CSV from the list
   view. The plugin's own `erpnext_sync_event` holds everything since 0.2.0.
4. **Uninstall**, on the bench that serves the site:

   ```bash
   bench --site <site> uninstall-app medusync --yes
   bench --site <site> migrate
   ```

   Uninstall drops the module's DocTypes and rows and runs `before_uninstall` if the app has
   one. Then check `Custom Field/Item-medusa_sync` and the `Medusa Sync: …` Webhooks are still
   there (they are ours, not the app's).
5. **Re-run Set up ERPNext** from the plugin and re-run the rehearsals; nothing should change.
6. When the last site is done: `bench remove-app medusync` on each bench, delete the
   `frappe16/apps/medusync` checkout, and archive the GitHub repository (read-only, with a
   note in its README pointing at this plugin).

## Sites known to carry it

| Site | Bench | Status |
|---|---|---|
| fixerp.localhost (local copy of production data) | frappe16 | **uninstalled 2026-09-26** (backup taken by bench); the plugin's field and Webhooks survived |
| medusync-vanilla.localhost | frappe16 | **uninstalled 2026-09-26** |
| frappe16.localhost | frappe16 | installed (not yet asked about) |
| new-mithtech-polemarch.localhost | frappe16 | installed (another product's site; not yet asked about) |
| erp.splendax.com (production, 49.13.233.158) | production bench | installed; the old secret pairing was abandoned mid-way — do not finish it |

Each row is a separate yes.
