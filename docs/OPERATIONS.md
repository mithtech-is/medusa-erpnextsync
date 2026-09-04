# Running the ERPNext connector

For the person keeping this working, rather than the person who wrote it.
The README explains what the plugin does; this explains what to do when it
is doing it wrong.

Everything here is in the Medusa admin under **ERPNext**, or one HTTP call
against `/admin/erpnext/…`.

---

## Connecting to ERPNext

The ERPNext side creates a **Medusync Site** record with two secrets.
Cross them over here:

| Here | There |
|---|---|
| `webhook_secret` | the site's **Outbound Secret** |
| `frappe_to_medusa_secret` | the site's **Inbound Secret** |

`erpnext_url` points at the Frappe site. `site_id` must match the Site ID
over there — it travels in every message and names the store in both logs.

`POST /admin/erpnext/ping` should come back green, and so should **Test
connection to Medusa** on the ERPNext side. Both, not one: they use
different secrets and prove different directions.

## Mappings

Mappings are authored on the ERPNext side and synchronised here, paired by
`mapping_uid`. Editing one here pushes it there and the other way round;
the higher `version` wins and ERPNext wins a tie.

Two things to know before touching one:

- **A mapping that arrives here for the first time arrives switched off.**
  Deliberately. Turning on a rule nobody here has reviewed is exactly what
  the design refuses to do.
- **ERPNext will not let its own copy be switched on remotely** unless it
  has been rehearsed there. Enabling here does not enable there.

### Trying one before trusting it

```
GET  /admin/erpnext/studio/sample?entity=product[&id=prod_123]
POST /admin/erpnext/mappings/{id}/dry-run     { "record_id": "..." }  # optional
POST /admin/erpnext/studio/plan-inbound       { "event": "...", "data": {} }
```

`dry-run` without a `record_id` rehearses against a sample built from the
entity's own declared paths, which is what a mapping nobody has used yet
needs. None of the three writes anything.

There is no admin page for these yet — see `pending_work/`.

## Reading the log

`erpnext_sync_event`, in the admin under **ERPNext → Events**.

| Status | Means |
|---|---|
| pending | in flight |
| success | the far side took it |
| skipped | deliberately not sent or not applied; `last_error` says why |
| failed | it did not land; the retry job will try again |

`is_test = true` marks a rehearsal. Those are never retried, never
suppress a real push as a duplicate, and are deleted within a day. The
events list has no filter for them yet.

After an outage, once the cause is fixed:

```
POST /admin/erpnext/events/retry-failed   { "limit": 200 }
```

It re-sends everything that gave up, through the ordinary path.

## Pushing and pulling by hand

```
POST /admin/erpnext/push/products
POST /admin/erpnext/push/customers
POST /admin/erpnext/push/orders
POST /admin/erpnext/pull/items
POST /admin/erpnext/mappings/{id}/pull-now
```

Pulling lives here rather than on the ERPNext side, and that is not an
oversight: nothing on that side reads from Medusa. The store pushes to
ERPNext and ERPNext pushes to the store, so "pull now" can only be here,
where the reader is.

## The catalogue

ERPNext owns it. Two rules you cannot configure away:

- An inbound update to a product ERPNext already has is **skipped**,
  unless somebody has turned on *Medusa May Update Catalogue Fields* over
  there.
- Deleting a product here **never** deletes the ERPNext Item. It unlinks:
  the Item keeps its stock, its history and its ledger entries, and simply
  stops claiming a Medusa product.

Whether a product created *here* may reach ERPNext at all is this side's
decision, `medusa_product_policy`: `off`, `link` (the default — it must be
attached to an existing Item first) or `create`.

## Starting over

```
POST /admin/erpnext/reset/request      { "site_id": "default" }   -> a secret, once
POST /admin/erpnext/reset/confirm      { "id": "...", "secret": "<ERPNext's>" }
GET  /admin/erpnext/reset/{id}
POST /admin/erpnext/reset/{id}/perform
```

Both systems have to agree. Each generates a secret and shows it once, and
each has to be handed the other's. Three minutes, single use.

This side clears `erpnext_sync_event` and switches off every mapping. It
keeps every product, customer and order and every ERPNext id on them —
losing those would leave both systems holding the same records and no
longer knowing it.

Afterwards nothing is running on either side. ERPNext restores its shipped
mappings, switched off, and pushes them over as they are enabled.

## Where the unfinished work is written down

`pending_work/`, one file per topic, each saying what exists today and what
has to be decided before it can be built. Tracked in git on purpose. The
Frappe app keeps its own; items touching both appear in both under the
same filename.
