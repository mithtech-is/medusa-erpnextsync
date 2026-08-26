# Customer Address + GSTIN sync (Medusa → ERPNext)

Closes audit gap #6/#7 (customer address + GSTIN not synced outbound).
Built + verified live on the demo stack, 2026-08-26.

## What syncs

On `customer.created` / `customer.updated` (and the admin **Push Customers**
bulk route), a customer now carries to ERPNext:

- **GSTIN** → `Customer.gstin` (built-in regional field; India Compliance app is
  *not* installed on this bench, and `gstin` rides through `_set_fields`, so no
  Frappe special-case is needed for it).
- **Addresses** → linked ERPNext `Address` docs (a separate doctype, Dynamic
  Link to Customer — a flat field mapping cannot express these).

## Data model (why it needs enrichment)

- GSTIN is **not** on the Medusa customer. It lives on the B2B **Company**
  (`company.gstin`); the customer links via `customer.company_id`. That column
  is a raw soft-FK not declared on the Medusa model, so `listCustomers` /
  `query.graph` don't return it — but every company-linked customer has the
  mirror `customer.metadata.company_id` (verified 11/11 on the demo DB). That
  mirror is the reliable lookup. (`company.applicant_email` is **not** reliable —
  older rows store the trade name there, not the email.)
- Addresses come from `customer.addresses[]` (already enriched via
  `fetchRelations: ["addresses"]`).

## Implementation

**Plugin (only place on the push path with a container):**
- `registry.ts` — wrap `customerEntity.fetchById`: resolve `metadata.company_id`
  → `company` module → attach `gstin`, `company_trade_name`,
  `company_billing_address` to the record. Fully guarded (no company module →
  plain customer, no GSTIN).
- `index.ts` — `augmentCustomerPayload(doctype, payload, record)` (sibling of
  `augmentSalesDocPayload`, invoked in `pushViaMapping`): copies `gstin` onto the
  payload and reshapes `addresses[]` into a normalized, stable-id'd
  `medusa_addresses[]`. The company's GST-registered `billing_address` is emitted
  as a synthetic entry keyed `company:<id>` so it dedupes like any other address.

**Frappe:**
- Custom Field `Address-medusa_address_id` (Data, unique) so re-pushes update the
  same Address instead of duplicating — created by `addr_setup.py`.
- `address_sync.sync_customer_addresses(customer_name, addresses)` — create/update
  Address docs (Dynamic Link → Customer), idempotent by `medusa_address_id`;
  ISO-2 country resolved via `Country.code` (`in` → `India`); unresolvable country
  → skip that address with the reason, never fail the customer; stale addresses
  (previously synced, now absent) are **disabled** (safe-delete, never destroyed).
- `mapped.py` — the Customer branch pops `medusa_addresses` before `_set_fields`
  and calls `sync_customer_addresses` after the Customer save (via `_cust_result`).

## Verified live (E2E)

Customer `cus_01KW9PQQQYHQMAFA73YHBB70YW` (`qa-onb3-2737263@example.com`):
- `fetchById` resolved **gstin `27AAACE1234A1Z5`**, company "Run Three Co", 1 address.
- After push: ERPNext Customer `gstin = 27AAACE1234A1Z5`; **2 linked Address docs**
  — the customer's own (`cuaddr_…`) and the synthetic company billing
  (`company:co_…`), both Pune/Maharashtra/**India**/411001.
- Pushed **3×** → still 2 addresses (idempotent, no duplicates).
- Unit test: dropping an address → it is **disabled**; country `in` → `India`;
  no duplicate rows.

## Known limitation

Live sync fires on `customer.created`/`customer.updated` and the bulk **Push
Customers** route. A standalone address-only edit that does not also touch the
customer record (Medusa may emit `customer_address.*` rather than
`customer.updated`) will sync on the next customer update or bulk push, not
instantly. Wiring `customer_address.*` events is a follow-up once the exact
event name/payload is confirmed in QA.
