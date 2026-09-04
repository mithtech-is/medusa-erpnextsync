# Prices flowing Medusa → ERPNext

**Deferred from:** Phase 3 (entity breadth)
**Belongs to:** a later phase, once the mapping studio (Phase 4) can dry-run it
**Side:** both repos. This file is the Medusa half; `medusync/pending_work/`
holds the ERPNext half.

## What exists

Direction is already stored and already respected in one direction. A store's
price-list rules live on `Medusync Site → Price Lists` (list, direction, role,
tier code) and `medusync/price_lists.py` reads them:

| Direction | Today |
|---|---|
| `To Medusa` | ERPNext sends. Works. |
| `Two-way` | ERPNext sends. The other half is this file. |
| `From Medusa` | ERPNext sends nothing. Nothing arrives either. |
| `Don't Sync` | Nothing moves. Correct and complete. |

So `From Medusa` currently means "ERPNext keeps out of it", not "Medusa drives
it". The README says so in as many words; this file is the work that would make
the label true.

## What is missing

**Medusa side (this repo).**

- An outbound event when a variant price changes. The `variant` entity is in
  `registry.ts` and prices are reachable through the price set, but no
  subscriber pushes a price change; today prices only ever travel the other
  way.
- The event has to name the price list it belongs to. A Medusa price is a
  (currency, rule set) tuple; an ERPNext Item Price belongs to a named list. A
  store that receives three ERPNext lists has to be able to say which one it is
  sending back, or ERPNext cannot decide whether it is allowed to accept it.
  Likely shape: `price_list` on the payload, matched against the store's own
  rules.
- Tier prices are worse: a Medusa customer-tier price would map back to an Item
  Price on the list whose rule carries that tier code, at the packing unit that
  matches its quantity bracket. The bracket has no obvious Medusa equivalent.

**ERPNext side (`medusync`).**

- `price_lists.accepts_inbound(price_list, site_id)` already exists and already
  answers correctly. Nothing calls it. That is the seam.
- An inbound handler that creates or updates an `Item Price` for
  (item, price list, currency, packing unit), refusing anything the rule does
  not permit — and refusing it as a **skip**, not a failure, the way the
  catalogue guard does, so a store that keeps sending an unwanted price does not
  build a retry queue.
- A loop-prevention question worth settling before writing code: ERPNext pushing
  a price, Medusa applying it and pushing it back is exactly the shape the echo
  breadcrumbs were built for, but a *rounded* return trip (minor units, tax
  inclusion) may not compare equal to what was sent. Decide whether the guard is
  the breadcrumb, a tolerance comparison, or both.

## Why it was left

Phase 3's job was to stop one global setting standing in for many warehouses and
many price lists. The direction field is the configuration that makes an inbound
path possible; building the path itself needs the test studio from Phase 4 to be
usable at all, because a wrong price reaching ERPNext is expensive in a way a
wrong stock level is not.

## Questions this is waiting on

See `00-QUESTIONS-ANSWER-THESE-FIRST.md`.

- **Q10** — which ERPNext Price List a price coming back from Medusa belongs
  to. There is no obvious answer: Medusa has no concept of the list it came
  from once the price is stored.
- **Q11** — what happens to a Medusa tier price, which has no quantity
  bracket, when ERPNext tiers are defined by one.
- **Q12** — how much rounding tolerance the echo guard allows, since a
  price crossing to minor units and back may not compare equal.
- **Q13** — whether an inbound price may create an Item Price or only
  update one that exists.

All four have to be answered together: they are one design. A wrong price
landing in ERPNext is expensive in a way a wrong stock level is not, which
is why none of it was guessed at.
