# Production checklist (erp.splendax.com ↔ splendax.com)

Everything below is read from what the local run against fixerp (a copy of production data)
needed. Do it in this order; nothing here is run by the plugin on its own.

## On the ERPNext bench

1. **Server scripts on.** fixerp carries *Sales Order Before Save* and *Sales Invoice Before
   Save* Server Scripts; production presumably does too. Frappe 15+ reads the switch from the
   bench-wide config only, cached per web worker:

   ```bash
   bench set-config -g server_script_enabled true
   ```

   then reload the web workers. Without it every Sales Order and Sales Invoice write answers
   `HTTP 403 … Server Scripts are disabled` and nothing is created.
2. **API user**: System Manager (Set up ERPNext creates a Custom Field and Webhooks). It needs
   read on Property Setter, Custom Field, Bin, Item Price, and write on Customer, Address,
   Sales Order, Sales Invoice. It does not need delete.
3. **Auto Insert Item Price If Missing** (Stock Settings): with it on, the first Sales Order
   for an Item with no price on the selling list records the store's rate as an Item Price.
   Decide whether that is wanted.

## In the plugin (Settings)

4. ERPNext URL, API key and secret, Medusa public URL (`https://splendax.com`'s backend).
   Selection doctypes: `Item`, allow. **Set up ERPNext**: field + two Webhooks, and once
   stock/prices are on, five more.
5. **Pushing to ERPNext**: Company, selling price list, customer group, territory, shipping
   account (e.g. "Freight and Forwarding Charges - <abbr>"), taxes template (e.g.
   "Output GST In-state - <abbr>"). What an order becomes: Sales Order and Sales Invoice.
6. **Mappings, then rehearse each** — the rehearsal names every mandatory field the site
   added (Property Setters and Custom Fields). On fixerp these were:
   - Customer: `source` (Lead Source), `account_manager` (User), `default_currency`,
     `market_segment`, `industry` — fixed values on the customer mapping.
   - Sales Order: `custom_sales_type` (Select), `custom_sub` (Small Text), and for the invoice
     `tc_name` (Terms and Conditions; the terms text is rendered from it).
   A mapping cannot be switched on until its rehearsal passes.
7. **Stock and prices**: warehouse (one), Medusa stock location id, safety stock; switch on,
   run Set up ERPNext again, then *Refresh stock and prices now* once.

## Splendx

8. Vendored tarball ≥ 0.3.0 in `deploy/backend/vendor/mithtech/`, `apps/backend/package.json`
   pointing at it, `pnpm install`, `medusa db:migrate --execute-safe-links`, restart.
9. After the first live order: check Events for the `order.synced` row, the Sales Order on
   ERPNext, and the Item Price side effect above.
