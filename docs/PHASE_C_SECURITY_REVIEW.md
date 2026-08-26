# Phase C — security review & hardening

**Date:** 2026-08-25. Scope: the two webhook surfaces that carry the sync —
medusync's `receive` / `receive_mapped` (Frappe side) and the plugin's
`POST /webhooks/erpnext-inbound` (Medusa side) — plus secret handling and the
admin surfaces.

## What was already sound (verified by reading + testing)

1. **Authentication = HMAC-SHA256 over the raw body**, both directions.
   Constant-time comparison (`hmac.compare_digest` on the Frappe side, a
   timing-safe equal on the Medusa side). Bad or missing signature → **401**,
   before any parsing or DB work. Verified: a request with a wrong signature is
   rejected 401.
2. **`allow_guest` endpoints are safe.** They must be reachable without a Frappe
   login (the caller is a server), and they are — but every one is gated by the
   HMAC check first, so "guest" never means "unauthenticated".
3. **No secrets in URLs or query strings.** The shared secret is only ever an
   HMAC key used to sign the body; it is never sent, never in the path/query.
   The webhook URLs are safe to log — knowing the URL grants nothing without the
   secret. (This is the "links aren't leakable" property.)
4. **Secrets at rest.** Frappe stores them as encrypted `Password` fields; the
   Medusa side stores them encrypted-at-rest and the admin API only ever returns
   **masked** values. They are not written to sync logs (the logs hold the event
   body, which carries the payload + timestamp — never the signing key).
5. **Idempotency.** Every event carries an `event_id`; a repeat is skipped
   ("already applied"). This already stops re-application of a replayed request —
   *while the log row exists*.

## Gap found and fixed — replay window

**The gap:** idempotency only protects until the log row is pruned
(`log_retention_days`, default 30). A request captured off the wire and replayed
after that window would re-apply. The signature stays valid because it only
covers the body, and the body is unchanged.

**The fix (implemented + verified):** every signed request now carries a `ts`
(unix seconds) **inside the signed body**, so it cannot be re-dated without
breaking the HMAC. Both receivers reject anything outside a ±300 s window, and
reject a request with no `ts` at all.

- Senders updated: plugin mapped-push + full-forward, medusync outbound
  delivery, and the "test connection" ping.
- Receivers updated: medusync `receive` + `receive_mapped`, plugin
  `receiveInbound`.

**Verified:**
| Request | Result |
|---|---|
| fresh `ts` (Medusa→Frappe) | **200 accepted** |
| `ts` 10 min old | **401 rejected** |
| `ts` 10 min in the future | **401 rejected** |
| no `ts` | **401 rejected** |
| stale `ts` (Frappe→Medusa, plugin inbound) | **401 rejected** |
| full round-trips both ways with fresh `ts` | **still work** (no regression) |

## Residual recommendations (for the production cutover)

These are defense-in-depth or deployment concerns, not code defects:

1. **TLS in production.** The demo runs over plain HTTP on localhost. In prod
   both base URLs must be `https://`, and `verify_ssl` (already defaulted on)
   must stay on so the pusher validates the receiver's certificate. HMAC
   protects integrity/authenticity; TLS protects confidentiality of the payload
   (which can contain customer PII) and stops a network observer from even
   capturing a request to replay within the 5-minute window.
2. **Rate-limiting** on the two receive endpoints as a DoS backstop. Brute-forcing
   the 256-bit secret is infeasible and bad signatures are rejected cheaply, so
   this is low-urgency; if added, set the limit generously (a bulk resync is one
   IP sending many valid requests) so it never throttles legitimate sync bursts.
3. **Error verbosity.** Receiver errors should return a short generic message and
   log the detail server-side, rather than surfacing a stack trace to the caller.
   The one path that used to leak a traceback (the `Medusync Log.action` Select
   error) was fixed in Phase A; keep an eye that new handlers don't reintroduce
   verbose 5xx bodies.
4. **Secret rotation.** Rotate the two shared secrets on a schedule. Rotate one
   side, then the other; brief 401s during the gap are expected and the retry
   crons recover. Never reuse the at-rest encryption key as a webhook secret.
5. **Restrict method to POST.** Both receivers are effectively POST-only (a GET
   carries no body, so the signature can't match and it 401s), but pinning the
   method explicitly removes any ambiguity.

## Verdict
Authentication, secret handling, and "no leakable links" were already sound; the
one real weakness — replayability of a captured request after log pruning — is
now closed with a signed, enforced timestamp window, verified in both directions.
The remaining items are deployment hygiene (TLS, rotation) and optional
defense-in-depth (rate-limiting), documented above for the prod cutover.
