import { model } from "@medusajs/framework/utils"

/**
 * `erpnext_invoice` — an invoice a customer can see for one order.
 *
 * Two kinds, depending on who numbers invoices for this store:
 *   - source "erpnext": ERPNext issued it and sent it here; the PDF is
 *     fetched from ERPNext and kept privately (see ../invoice-storage.ts).
 *   - source "store": this store issued the number itself and sent it to
 *     ERPNext. ERPNext books it and sends nothing back.
 *
 * The file is never public. `object_key` names it inside the configured
 * storage and is only ever read through the authenticated store route,
 * which checks the order belongs to the customer asking.
 */
export const ErpnextInvoice = model
    .define("erpnext_invoice", {
        id: model.id().primaryKey(),
        order_id: model.text().index(),
        customer_id: model.text().nullable(),
        number: model.text(),
        source: model.text().default("erpnext"),
        invoice_date: model.text().nullable(),
        total: model.number().nullable(),
        currency: model.text().nullable(),
        status: model.text().nullable(),
        storage: model.text().nullable(),
        object_key: model.text().nullable(),
        content_type: model.text().nullable(),
        size_bytes: model.number().nullable(),
        fetched_at: model.dateTime().nullable(),
        fetch_error: model.text().nullable(),
    })
