# Running the ERPNext connector

For the person keeping this working, rather than the person who wrote it.
The README explains what the plugin does; this explains what to do when it
is doing it wrong.

Everything here is in the Medusa admin under **ERPNext**, or one HTTP call
against `/admin/erpnext/…`.

---

## Connecting to ERPNext

Nothing is installed on ERPNext. On the Settings tab:

| Field | What |
|---|---|
| ERPNext URL | the Frappe site |
| API key / secret | a Frappe API user; needs **System Manager** for the setup |
| Medusa public URL | where ERPNext reaches this store; the webhooks POST to `<url>/webhooks/erpnext-inbound` |
| Frappe webhook secret | generated for you by Set up ERPNext; rotate with Generate |
| Selection | the DocTypes that get the **Sync to Medusa** tick, each allow or deny list |

Save, **Test connection** (`POST /admin/erpnext/ping`), then **Set up
ERPNext** (`POST /admin/erpnext/setup`). The report lists the Custom Field
and the two Webhooks per DocType as created, updated, unchanged or error.
Run it again whenever the public URL, the secret or the selection changes;
it is idempotent.

On the ERPNext side the evidence is **Webhook Request Log**: one row per
delivery attempt, with the request and the response. No row means the
condition did not fire (the document was not ticked, before or after the
save). A row with a 401 means the secret differs: rotate it here and run
Set up ERPNext again.

## Mappings

Mappings live here only. A mapping pairs one Medusa entity with one
DocType; the pair is its identity and there is one per pair.

- **Pull** and **both** mappings on a selection DocType receive webhooks
  and are polled every 5 minutes for ticked rows.
- **Push** mappings are evaluated but **paused** in this release: the log
  shows `paused`, nothing leaves.

### Trying one before trusting it

```
GET  /admin/erpnext/studio/sample?entity=product[&id=prod_123]
POST /admin/erpnext/mappings/{id}/dry-run     { "record_id": "..." }  # optional
POST /admin/erpnext/studio/plan-inbound       { "event": "on_update", "doctype": "Item",
                                                "name": "SKU-1", "doc": { ... } }
```

`plan-inbound` takes what a Frappe Webhook sends and says what each mapping
would do with it. None of the three writes anything.

## Reading the log

`erpnext_sync_event`, in the admin under **ERPNext → Events**.

| Status | Means |
|---|---|
| pending | in flight |
| success | applied; `action` says what: created, updated, drafted |
| skipped | deliberately not applied; `last_error` says why (not ticked, no mapping, paused) |
| failed | a write failed; the retry job replays it |
| poison | gave up; a row from before the webhook era, or too many attempts |

Inbound rows carry `event_id = frappe:<event>:<doctype>:<name>:<modified>`,
so Frappe's own retries of one delivery land on one row. Replaying one:

```
POST /admin/erpnext/events/{event_id}/retry
POST /admin/erpnext/events/retry-failed   { "limit": 200 }
```

## Pushing and pulling by hand

```
POST /admin/erpnext/mappings/{id}/pull-now            { "full": true }   # full = ignore the watermark
POST /admin/erpnext/pull/items                                           # preview, read-only
POST /admin/erpnext/push/products|customers|orders                       # paused: logged, not sent
```

## The catalogue

ERPNext owns it. The rules:

- Only a **ticked** document reaches the store. Untick it or delete it and
  its product goes to **draft**; tick it again and the same product is
  republished. Nothing is ever deleted here on ERPNext's say-so.
- Deleting a product here **never** touches the ERPNext Item.
- Whether a product created *here* may reach ERPNext at all is
  `medusa_product_policy`: `off`, `link` (the default — it must be attached
  to an existing Item first) or `create`. Moot while pushes are paused.

The hourly reconciliation drafts the products of linked documents that no
longer carry the tick; its counts are in the server log under
`[erpnext-recon] selection reconcile`.

## Starting over

There is no reset ceremony any more. To stop everything: switch **Sync
enabled** off. To forget the log: lower the retention or truncate
`erpnext_sync_event`. To forget which document became which product:
truncate `erpnext_link` — the next webhook or pull rebuilds it by the
mapping's key. Products, customers and orders are never touched.

## Where the unfinished work is written down

`pending_work/`, one file per topic, each saying what exists today and what
has to be decided before it can be built. Tracked in git on purpose. This
repo is their only home.
