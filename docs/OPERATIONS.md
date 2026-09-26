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
| Selection | the DocTypes that get the **Sync to Medusa** field (blank / ERPNext → Medusa / Medusa → ERPNext / Both), each allow or deny list |
| Default phone region | what a phone number without a country code is assumed to be (IN) |

Save, **Test connection** (`POST /admin/erpnext/ping`), then **Set up
ERPNext** (`POST /admin/erpnext/setup`). The report lists the Custom Field
and the two Webhooks per DocType as created, updated, unchanged or error.
Run it again whenever the public URL, the secret or the selection changes;
it is idempotent.

On the ERPNext side the evidence is **Webhook Request Log**: one row per
delivery attempt, with the request and the response. No row means the
condition did not fire (the document was not on ERPNext → Medusa or Both,
before or after the save). A row with a 401 means the secret differs: rotate it here and run
Set up ERPNext again.

### When a webhook does not arrive

- **No Webhook Request Log row on ERPNext:** the condition did not fire.
  The document must be on ERPNext → Medusa or Both now or before the
  save, or the field must have changed. `Set up ERPNext` shows whether
  the webhooks exist and are enabled.
- **A row exists, but only minutes later:** Frappe delivers webhooks from
  its background worker (`default` queue). After a bench restart that
  queue can hold hundreds of scheduled jobs; deliveries wait behind
  them. `bench doctor` on the ERPNext side shows the queue; nothing on
  this side is wrong.
- **The row's response is a 401:** the secret differs. Rotate it here
  (Generate) and run Set up ERPNext again.
- **The row's response is a 400 about the raw body:** the Webhook lost
  its `Content-Type: application/json` header row. Run Set up ERPNext.
- **Set up ERPNext reports "unreachable" the first time on a big site:**
  creating the field alters the DocType's table; on tens of thousands of
  rows that takes a while. The plugin waits up to three minutes; run it
  again if it still reports an error, the field is usually there.

## Mappings

Mappings live here only. A mapping pairs one Medusa entity with one
DocType; the pair is its identity and there is one per pair.

- **Pull** and **both** mappings on a selection DocType receive webhooks
  and are polled every 5 minutes for rows on ERPNext → Medusa or Both.
- A document narrows its mapping, never widens it: a push for a document
  ERPNext last showed as ERPNext → Medusa, or blank, is skipped as
  `record-direction`.
- **Push** mappings write over REST. Settings → *Pushing to ERPNext* names
  the Company, price list, customer group, territory, shipping account and
  taxes template; blank means ERPNext's default. A line with no ERPNext
  Item stops an order (`failed`, naming the SKUs) rather than shipping it
  short; link the product or create the Item and retry the event.

### When a push is refused

- **"Value missing for Customer: …"** — the site made those fields mandatory
  (a Property Setter, or a Custom Field). The rehearsal names them, reading
  the DocType, its Custom Fields and its Property Setters; the push fills a
  Customer's name, type and contact and a Sales Order's party, dates,
  currency and lines itself, and Settings fill customer group, territory
  and company. Everything else needs a pair or a fixed value on the mapping
  (a Link needs a name that exists on that site — the value picker lists
  them).
- **`HTTP 403: … Server Scripts are disabled`** — the site has a Server
  Script on that DocType (fixerp has *Sales Order Before Save* and *Sales
  Invoice Before Save*) and the bench has not enabled scripts. Frappe 15+
  reads the switch from `common_site_config.json` only:
  `bench set-config -g server_script_enabled true`, then restart the web
  workers. Nothing is created until then; ERPNext rolls the request back.
- **"Item Price added for … in Price List - Standard Selling"** is not an
  error: with Stock Settings → *Auto Insert Item Price If Missing* on,
  ERPNext records the store's line rate as an Item Price in the selling
  price list the first time an Item is sold at a price it has no entry for.
  Turn the setting off on ERPNext if the store's prices must not seed the
  price list.
- A write waits up to 90 s: ERPNext validates and names a Customer or a
  Sales Order before it answers, and a busy site takes 20–50 s.
- **The invoice's own mandatory fields** (fixerp: Terms and Conditions)
  are checked by the order mapping's rehearsal when Settings raise a
  Sales Invoice; a fixed value on the order mapping lands on both
  documents. A `tc_name` pair is enough: the push renders the terms text
  from it, as the form does.
- **Taxes**: with a taxes template in Settings its rows are put on every
  Sales Order and Sales Invoice ahead of the shipping charge, so the
  ERPNext grand total equals the store's order total. Without one, the
  documents carry no tax rows and ERPNext's total is the net amount.
- The Sales Invoice is a draft that names the draft Sales Order's rows.
  Submit the order first, then the invoice; ERPNext refuses the other way
  round.

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
| skipped | deliberately not applied; `last_error` says why (not selected, no mapping, paused) |
| failed | a write failed; the retry job replays it |
| poison | gave up; a row from before the webhook era, or too many attempts |

The retry job (every 5 minutes) replays `failed` and stale `pending` rows
only — a `skipped` row records a decision. Each push writes its own row
with a snapshot of the record, so an older failed row for the same record
and mapping is marked `superseded` when a newer one exists rather than
resending the older snapshot next to a live push.

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
POST /admin/erpnext/push/products|customers|orders                       # through the push mappings
```

## The catalogue

ERPNext owns it. The rules:

- Only a document on **ERPNext → Medusa** or **Both** reaches the store.
  Blank it or delete it and its product goes to **draft**; select it again
  and the same product is republished. A **Medusa → ERPNext** document is
  Medusa's own and is never drafted. Nothing is ever deleted here on
  ERPNext's say-so.
- Deleting a product here **never** touches the ERPNext Item.
- Whether a product created *here* may reach ERPNext at all is
  `medusa_product_policy`: `off`, `link` (the default — it must be attached
  to an existing Item first) or `create`. Moot while pushes are paused.

The hourly reconciliation drafts the products of linked documents that no
longer move ERPNext → Medusa; its counts are in the server log under
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
