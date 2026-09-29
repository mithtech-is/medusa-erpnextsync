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
| Selection | the DocTypes that get the **Sync to Medusa** field (None / ERPNext → Medusa / Medusa → ERPNext / Both), each allow or deny list |
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
  ERPNext last showed as ERPNext → Medusa, or None, is skipped as
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
  and company (group and territory only on a new Customer or where
  ERPNext has them blank). Everything else needs a pair or a fixed value on the mapping
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
  ERPNext grand total equals the store's order total. An order shipped to
  another state than the company address's gets the company's sibling
  template whose Tax Category is inter-state (and the other way round), so
  India Compliance accepts it; name the in-state template in Settings.
  Without one, the documents carry no tax rows and ERPNext's total is the
  net amount.
- The Sales Invoice is a draft that names the draft Sales Order's rows.
  Submit the order first, then the invoice; ERPNext refuses the other way
  round.

### Several DocTypes in one sync

Under **More DocTypes in this sync** name the DocType and how it is tied
to the main one (a Link field on it, or its Links table). Field pairs
then carry a DocType choice. Set up ERPNext adds an unconditioned
`on_update` webhook for each secondary DocType, so a change there comes
back as a change to the main document. A secondary write that fails
fails the whole row, and the retry redoes the main write too (idempotent
through the link table).

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

## Stock and prices

ERPNext owns both. Switch them on under Settings → *Stock and prices from
ERPNext*, name the warehouse and the Medusa stock location, then run Set
up ERPNext again: it adds the Webhooks (`Stock Ledger Entry after_insert`
at that warehouse, `Sales Order on_submit` / `on_cancel`, `Item Price
on_update` / `on_trash` on the selling price list).

- A level is `actual − reserved − safety + held`, never negative, read from
  the Bin when an event arrives, not from the event.
  - `held` is what Medusa still reserves for store orders whose Sales Order
    is submitted: ERPNext reserves those units too, so without it each
    order would count twice.
  - The Item's own `safety_stock` wins over the Settings buffer when it is set.
- Fulfil store orders in ERPNext: submit the Sales Order, make a Delivery
  Note from it. The note's ledger entries create the Medusa fulfilment,
  shipped, with the LR number as tracking. Do not also fulfil in Medusa
  Admin. Cancelling the note fails its event row with what to do: Medusa
  does not cancel a shipped fulfilment, so record a return there.
- A selling price on the store's list is the variant's price in that
  currency. Tiers, customer prices and dated prices are skipped and the
  row says why.
- Only an Item on ERPNext → Medusa or Both moves; a Medusa-owned Item's
  stock and price stay where they are.
- Missed deliveries are caught by the hourly reconcile, and by every
  catalogue pull for the Items it pulled. On demand:

```
POST /admin/erpnext/stock-prices/refresh            { "item_codes": ["SKU-1"] }   # or {} for every linked Item
```

A product with several variants and no variant carrying the Item code as
its SKU is skipped ("no variant for Item"); give the right variant that
SKU.

## GST

ERPNext computes it (India Compliance) and the store charges the same:

- A Sales Order or Invoice gets its tax rows from `get_party_details`, so
  the template follows the place of supply, and each line is taxed at its
  Item Tax Template. Shipping is an Actual row on the Settings shipping
  account ahead of the GST rows ("On Previous Row Total"), taxed at the
  rates of the goods it carries.
- A pulled product is charged at its Item's template rate (the Item's,
  else its group's), recorded as a product rule on a "GST n%" rate of the
  tax region of the company's country. A change of an Item Group's taxes
  alone reaches products the next time each Item is saved or pulled.
- The storefront calls `POST /store/carts/:id/erpnext-rounding` before
  checkout and payment, so the cart's total is ERPNext's rounded total.
  "skipped: … differ by more than 1" means the store and ERPNext disagree
  on a rate or a price; fix the data, do not round over it.

## The catalogue

ERPNext owns it. The rules:

- Only a document on **ERPNext → Medusa** or **Both** reaches the store.
  Set it to None or delete it and its product goes to **draft**; select it again
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
