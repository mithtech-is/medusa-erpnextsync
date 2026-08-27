/**
 * F2 — Frappe Webhook row blueprints + seeder.
 *
 * Operator-side architecture: Frappe ships a `Webhook` doctype (visible
 * at /app/webhook) that lets you wire HTTP POSTs from the desk UI
 * declaratively. We use it for ALL Frappe→Medusa pushes — zero custom
 * Python in the polemarch app for sync logic. Frappe core handles:
 *   - 3 inline retries with 1s/4s/7s backoff
 *   - Webhook Request Log per attempt (audit trail)
 *   - HMAC-SHA256 signing via webhook_secret (base64 in
 *     X-Frappe-Webhook-Signature)
 *   - Background queue execution (non-blocking)
 *
 * This file maps each canonical mapping to one (or more) Frappe Webhook
 * rows. The seeder POSTs to /api/resource/Webhook with the api_key:
 * api_secret stored on erpnext_setting. Idempotent — looks up by name
 * (Webhook rows are named by `webhook_doctype + webhook_docevent`).
 *
 * Event-name discipline: each Webhook row's JSON body sets
 *   event:    <medusa-event-name>      (matches receiveInbound dispatcher)
 *   event_id: frappe:<doctype>:<name>:<modified>   (idempotency key)
 *   data:     {...doc fields the receiver needs}
 *
 * Adding a new Frappe→Medusa push:
 *   1. Add a canonical mapping (or reuse existing) in canonical-mappings.ts
 *   2. Add a blueprint here that matches the mapping's doctype
 *   3. Run the seeder (admin button F4 / migration)
 *   4. Wire a handler in `dispatchInbound` in modules/erpnext/index.ts
 */

export type FrappeWebhookBlueprint = {
    /** Stable name for upsert lookup. Use `<doctype>__<docevent>__<event>`. */
    name: string
    webhook_doctype: string
    webhook_docevent:
        | "after_insert"
        | "on_update"
        | "on_submit"
        | "on_cancel"
        | "on_change"
        | "on_update_after_submit"
    /** Optional Python expression that the doc must satisfy.
     *  e.g. "doc.docstatus == 1 and not doc.medusa_originated"
     *  Empty = always fire. */
    condition: string
    /** Path appended to the Medusa base URL (set at seed time from
     *  erpnext_setting.erpnext_url's sibling field — see seeder). */
    request_path: string
    /** Jinja template — Frappe renders against doc context. Must emit
     *  the {event, event_id, data} shape receiveInbound expects. */
    webhook_json: string
}

/**
 * Customer webhook JSON template — shared by after_insert + on_update.
 *
 * Frappe's webhook_json field is fed through Jinja before posting. JSON.
 * stringify-ing a JS object can carry `{{ }}` substitutions because they
 * sit inside string values, but it can NOT carry `{% for %}` control
 * blocks because those produce structural output (an array of objects).
 * So we build the template as a raw string and validate it round-trips
 * through JSON.parse with the loops replaced by `[]` placeholders.
 *
 * The bank_accounts + demat_accounts arrays carry the child rows for
 * the Phase B reverse-sync path: when an operator adds/edits a bank or
 * demat on the Frappe Customer form, the Medusa-side handler picks up
 * the diff and upserts the row on Medusa (subject to idempotency —
 * unchanged rows are a no-op so the push back doesn't loop).
 */
function customerWebhookJson(event: "customer.created" | "customer.updated"): string {
    // Build child-table loops as raw Jinja. Each iteration emits one
    // {...} JSON object; `loop.last` avoids the trailing comma. The
    // `|tojson` filter handles JSON string escaping (quotes, backslashes,
    // unicode) for every embedded value — `|e` is wrong here because
    // it HTML-escapes (`&` → `&amp;`), and a raw `{{ }}` would break
    // JSON the moment a field value contains a double-quote.
    const bankLoop =
        '{% for row in doc.custom_bank_details %}' +
        '{' +
        '"bank_code": {{ (row.bank_code or "") | tojson }},' +
        '"ac_number": {{ (row.ac_number or "") | tojson }},' +
        '"bank_name": {{ (row.bank_name or "") | tojson }},' +
        '"account_holder": {{ (row.account_holder or "") | tojson }},' +
        '"is_primary": {% if row.is_primary %}1{% else %}0{% endif %},' +
        '"cheque_image": {{ (row.cheque_image or "") | tojson }}' +
        '}' +
        '{% if not loop.last %},{% endif %}' +
        '{% endfor %}'
    const dematLoop =
        '{% for row in doc.custom_dp_details %}' +
        '{' +
        '"dp_id": {{ (row.dp_id or "") | tojson }},' +
        '"client_id": {{ (row.client_id or "") | tojson }},' +
        '"bo_id": {{ (row.bo_id or "") | tojson }},' +
        '"depository": {{ (row.depository or "") | tojson }},' +
        '"dp_name": {{ (row.dp_name or "") | tojson }},' +
        '"primary_bo_name": {{ (row.primary_bo_name or "") | tojson }},' +
        '"is_primary": {% if row.is_primary %}1{% else %}0{% endif %},' +
        '"cmr_copy": {{ (row.cmr_copy or "") | tojson }}' +
        '}' +
        '{% if not loop.last %},{% endif %}' +
        '{% endfor %}'
    return (
        '{' +
        `"event": "${event}",` +
        '"event_id": "frappe:Customer:{{ doc.name }}:{{ doc.modified }}",' +
        '"data": {' +
        '"name": {{ doc.name | tojson }},' +
        '"email_id": {{ (doc.email_id or "") | tojson }},' +
        '"customer_name": {{ (doc.customer_name or "") | tojson }},' +
        '"mobile_no": {{ (doc.mobile_no or "") | tojson }},' +
        '"pan": {{ (doc.pan or "") | tojson }},' +
        '"gstin": {{ (doc.gstin or "") | tojson }},' +
        '"custom_dob": {{ (doc.custom_dob or "") | tojson }},' +
        '"custom_kyc_status": {{ (doc.custom_kyc_status or "") | tojson }},' +
        '"custom_kyc_verified_on": {{ (doc.custom_kyc_verified_on or "") | tojson }},' +
        '"custom_client_id": {{ (doc.custom_client_id or "") | tojson }},' +
        // custom_is_polemarch_customer was retired in Frappe v0_26_0.
        // The single surviving sync-gate flag is custom_is_mithtech_only.
        '"custom_is_mithtech_only": {% if doc.custom_is_mithtech_only %}1{% else %}0{% endif %},' +
        '"bank_accounts": [' + bankLoop + '],' +
        '"demat_accounts": [' + dematLoop + '],' +
        '"modified": "{{ doc.modified }}"' +
        '}' +
        '}'
    )
}

/**
 * The Webhook rows we want on the Frappe side. Each one is the
 * "trigger leg" of a canonical mapping's push direction.
 */
export const FRAPPE_WEBHOOK_BLUEPRINTS: FrappeWebhookBlueprint[] = [
    // ── Customer ───────────────────────────────────────────────
    {
        name: "Customer__after_insert__customer.created",
        webhook_doctype: "Customer",
        webhook_docevent: "after_insert",
        // Skip mithtech-only opt-outs; everyone else is a Polemarch
        // customer by default (the legacy `custom_is_polemarch_customer`
        // auto-derived flag was retired in Frappe v0_26_0).
        condition: "not doc.custom_is_mithtech_only",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: customerWebhookJson("customer.created"),
    },
    {
        name: "Customer__on_update__customer.updated",
        webhook_doctype: "Customer",
        webhook_docevent: "on_update",
        condition: "not doc.custom_is_mithtech_only",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: customerWebhookJson("customer.updated"),
    },

    // ── Security ────────────────────────────────────────────────
    {
        name: "Security__after_insert__security.created",
        webhook_doctype: "Security",
        webhook_docevent: "after_insert",
        condition: "",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "security.updated",
            event_id:
                "frappe:Security:{{ doc.name }}:{{ doc.modified }}",
            data: {
                name: "{{ doc.name }}",
                isin: "{{ doc.isin or '' }}",
                security_name: "{{ doc.security_name or '' }}",
                security_type: "{{ doc.security_type or '' }}",
                face_value: "{{ doc.face_value or 0 }}",
                last_traded_price:
                    "{{ doc.last_traded_price or 0 }}",
                tradable: "{{ 1 if doc.tradable else 0 }}",
                active: "{{ 1 if doc.active else 0 }}",
                company_name: "{{ doc.company_name or '' }}",
                sector: "{{ doc.sector or '' }}",
                rta: "{{ doc.rta or '' }}",
                polemarch_page_url:
                    "{{ doc.polemarch_page_url or '' }}",
                calcula_page_url:
                    "{{ doc.calcula_page_url or '' }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },
    {
        name: "Security__on_update__security.updated",
        webhook_doctype: "Security",
        webhook_docevent: "on_update",
        condition: "",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "security.updated",
            event_id:
                "frappe:Security:{{ doc.name }}:{{ doc.modified }}",
            data: {
                name: "{{ doc.name }}",
                isin: "{{ doc.isin or '' }}",
                security_name: "{{ doc.security_name or '' }}",
                security_type: "{{ doc.security_type or '' }}",
                face_value: "{{ doc.face_value or 0 }}",
                last_traded_price:
                    "{{ doc.last_traded_price or 0 }}",
                tradable: "{{ 1 if doc.tradable else 0 }}",
                active: "{{ 1 if doc.active else 0 }}",
                company_name: "{{ doc.company_name or '' }}",
                sector: "{{ doc.sector or '' }}",
                rta: "{{ doc.rta or '' }}",
                polemarch_page_url:
                    "{{ doc.polemarch_page_url or '' }}",
                calcula_page_url:
                    "{{ doc.calcula_page_url or '' }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },

    // ── Wallet Deposit ──────────────────────────────────────────
    // Only fire for operator-created rows (medusa_originated=0) AND
    // only after submit (docstatus=1).
    {
        name: "WalletDeposit__on_submit__wallet.deposit.received",
        webhook_doctype: "Wallet Deposit",
        webhook_docevent: "on_submit",
        condition: "doc.docstatus == 1 and not doc.medusa_originated",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "wallet.deposit.received",
            event_id:
                "frappe:Wallet Deposit:{{ doc.name }}:{{ doc.modified }}",
            data: {
                name: "{{ doc.name }}",
                customer: "{{ doc.customer or '' }}",
                // Wallet Deposit/Withdrawal doesn't have a
                // customer_email column — resolve it at fire time
                // from the linked Customer via Jinja's frappe.db
                // helper. Medusa-side _handleWalletCredit /
                // _handleWalletDebit key on email to find the
                // Medusa customer; without this lookup they'd skip
                // with "customer_not_found".
                customer_email:
                    "{{ frappe.db.get_value('Customer', doc.customer, 'email_id') or '' }}",
                amount: "{{ doc.amount or 0 }}",
                gateway_ref: "{{ doc.gateway_ref or '' }}",
                posting_date:
                    "{{ doc.posting_date or '' }}",
                mode: "{{ doc.mode or '' }}",
                remarks: "{{ doc.remarks or '' }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },

    // ── Wallet Withdrawal ───────────────────────────────────────
    {
        name: "WalletWithdrawal__on_submit__wallet.withdrawal.posted",
        webhook_doctype: "Wallet Withdrawal",
        webhook_docevent: "on_submit",
        condition: "doc.docstatus == 1 and not doc.medusa_originated",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "wallet.withdrawal.posted",
            event_id:
                "frappe:Wallet Withdrawal:{{ doc.name }}:{{ doc.modified }}",
            data: {
                name: "{{ doc.name }}",
                customer: "{{ doc.customer or '' }}",
                // Wallet Deposit/Withdrawal doesn't have a
                // customer_email column — resolve it at fire time
                // from the linked Customer via Jinja's frappe.db
                // helper. Medusa-side _handleWalletCredit /
                // _handleWalletDebit key on email to find the
                // Medusa customer; without this lookup they'd skip
                // with "customer_not_found".
                customer_email:
                    "{{ frappe.db.get_value('Customer', doc.customer, 'email_id') or '' }}",
                amount: "{{ doc.amount or 0 }}",
                gateway_ref: "{{ doc.gateway_ref or '' }}",
                posting_date:
                    "{{ doc.posting_date or '' }}",
                mode: "{{ doc.mode or '' }}",
                remarks: "{{ doc.remarks or '' }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },

    // ── Security Sale ───────────────────────────────────────────
    // Only operator-created sales (source != Platform Purchase) so
    // we don't bounce storefront orders back to Medusa.
    {
        name: "SecuritySale__on_submit__order.placed",
        webhook_doctype: "Security Sale",
        webhook_docevent: "on_submit",
        condition:
            "doc.docstatus == 1 and (doc.source or '') != 'Platform Purchase'",
        request_path: "/webhooks/erpnext-inbound",
        // `customer_email` is resolved server-side via a frappe.db.
        // get_value call in the Jinja template. The Medusa-side
        // _handleOrderPlaced handler needs email to look up the
        // Medusa customer (Frappe's `customer` field is a DocName,
        // not an email).
        webhook_json: JSON.stringify({
            event: "order.placed",
            event_id:
                "frappe:Security Sale:{{ doc.name }}:{{ doc.modified }}",
            data: {
                name: "{{ doc.name }}",
                customer: "{{ doc.customer or '' }}",
                customer_email:
                    "{{ frappe.db.get_value('Customer', doc.customer, 'email_id') or '' }}",
                security: "{{ doc.security or '' }}",
                qty: "{{ doc.qty or 0 }}",
                rate: "{{ doc.rate or 0 }}",
                source: "{{ doc.source or '' }}",
                posting_date:
                    "{{ doc.posting_date or '' }}",
                medusa_order_id:
                    "{{ doc.medusa_order_id or '' }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },
    {
        name: "SecuritySale__on_cancel__order.canceled",
        webhook_doctype: "Security Sale",
        webhook_docevent: "on_cancel",
        condition:
            "doc.docstatus == 2 and (doc.source or '') != 'Platform Purchase'",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "order.canceled",
            event_id:
                "frappe:Security Sale:{{ doc.name }}:{{ doc.modified }}:cancel",
            data: {
                name: "{{ doc.name }}",
                medusa_order_id:
                    "{{ doc.medusa_order_id or '' }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },

    // ── Security Purchase (Polemarch buys shares from customer) ─
    // Customer-Sell flow: customer sells shares to Polemarch.
    // When payment_method='Customer Wallet', Frappe controller
    // credits the customer's wallet atomically on submit. Medusa
    // needs to know so it can mirror the wallet credit.
    //
    // No source-filter here (unlike Security Sale) because Security
    // Purchase is operator-driven by definition — no storefront
    // equivalent.
    {
        name: "SecurityPurchase__on_submit__share.sale.completed",
        webhook_doctype: "Security Purchase",
        webhook_docevent: "on_submit",
        condition: "doc.docstatus == 1",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "share.sale.completed",
            event_id:
                "frappe:Security Purchase:{{ doc.name }}:{{ doc.modified }}",
            data: {
                name: "{{ doc.name }}",
                customer: "{{ doc.customer or '' }}",
                party: "{{ doc.party or '' }}",
                party_type: "{{ doc.party_type or '' }}",
                security: "{{ doc.security or '' }}",
                qty: "{{ doc.qty or 0 }}",
                rate: "{{ doc.rate or 0 }}",
                payment_method: "{{ doc.payment_method or '' }}",
                posting_date: "{{ doc.posting_date or '' }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },
    {
        name: "SecurityPurchase__on_cancel__share.sale.canceled",
        webhook_doctype: "Security Purchase",
        webhook_docevent: "on_cancel",
        condition: "doc.docstatus == 2",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "share.sale.canceled",
            event_id:
                "frappe:Security Purchase:{{ doc.name }}:{{ doc.modified }}:cancel",
            data: {
                name: "{{ doc.name }}",
                customer: "{{ doc.customer or '' }}",
                party: "{{ doc.party or '' }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },

    // ── Wallet Deposit / Withdrawal cancellation ─────────────────
    // Phase 28 wired the cancel cascade controller-side (before_cancel
    // severs the Wallet Transaction link, on_cancel reverses the
    // delta). Without an on_cancel webhook, Medusa misses the reversal
    // and shows a stale balance until the hourly reconciliation tick
    // catches the drift. These two webhooks close that gap so cancels
    // are real-time too.
    {
        name: "WalletDeposit__on_cancel__wallet.deposit.canceled",
        webhook_doctype: "Wallet Deposit",
        webhook_docevent: "on_cancel",
        condition: "doc.docstatus == 2 and not doc.medusa_originated",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "wallet.deposit.canceled",
            event_id:
                "frappe:Wallet Deposit:{{ doc.name }}:{{ doc.modified }}:cancel",
            data: {
                name: "{{ doc.name }}",
                customer: "{{ doc.customer or '' }}",
                customer_email: "{{ doc.customer_email or '' }}",
                amount: "{{ doc.amount or 0 }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },
    {
        name: "WalletWithdrawal__on_cancel__wallet.withdrawal.canceled",
        webhook_doctype: "Wallet Withdrawal",
        webhook_docevent: "on_cancel",
        condition: "doc.docstatus == 2 and not doc.medusa_originated",
        request_path: "/webhooks/erpnext-inbound",
        webhook_json: JSON.stringify({
            event: "wallet.withdrawal.canceled",
            event_id:
                "frappe:Wallet Withdrawal:{{ doc.name }}:{{ doc.modified }}:cancel",
            data: {
                name: "{{ doc.name }}",
                customer: "{{ doc.customer or '' }}",
                customer_email: "{{ doc.customer_email or '' }}",
                amount: "{{ doc.amount or 0 }}",
                modified: "{{ doc.modified }}",
            },
        }),
    },
]
