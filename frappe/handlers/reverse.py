# Post-order reverse path: ERPNext -> Medusa order metadata.
# Delivery Note -> fulfilment, Shipment -> tracking, Sales Invoice -> invoice.
# All delivered via the existing signed outbound pipe.
import hashlib
import json

import frappe

from medusync import config
from medusync.outbound import _create_log, deliver


def _order_id_from_so(so_name):
    if not so_name:
        return None
    return frappe.db.get_value("Sales Order", so_name, "medusa_order_id")


def _deliver(event, medusa_order_id, payload, ref, doctype, docname):
    body = dict(payload)
    body["medusa_order_id"] = medusa_order_id
    event_id = "frappe:%s:%s" % (event, ref)
    ph = hashlib.sha256(json.dumps(body, sort_keys=True, default=str).encode("utf-8")).hexdigest()
    log = _create_log(
        direction="Outbound", status="Queued", event=event, event_id=event_id,
        document_type=doctype, document_name=docname, payload_hash=ph, request_body=body,
    )
    deliver(log.name, event, event_id, body, attempt=1)


def _guard():
    return not frappe.flags.get("medusync_inbound") and config.is_enabled()


def on_delivery_note(doc, method=None):
    try:
        if not _guard():
            return
        so = None
        for it in (doc.items or []):
            if it.get("against_sales_order"):
                so = it.against_sales_order
                break
        oid = _order_id_from_so(so)
        if not oid:
            return
        cancelled = method == "on_cancel" or getattr(doc, "docstatus", 0) == 2
        payload = {
            "status": "cancelled" if cancelled else "dispatched",
            "items": [{"sku": it.item_code, "qty": it.qty} for it in (doc.items or [])],
            "lr_no": doc.get("lr_no"),
            "transporter": doc.get("transporter_name") or doc.get("transporter"),
            "vehicle_no": doc.get("vehicle_no"),
            "dispatched_at": str(doc.get("posting_date") or ""),
        }
        _deliver("order.fulfilled", oid, payload, "%s-%s" % (doc.name, method), "Delivery Note", doc.name)
    except Exception:
        frappe.log_error(title="medusync reverse DN hook failed", message=frappe.get_traceback())


def on_shipment(doc, method=None):
    try:
        if not _guard():
            return
        so = None
        for dn in (doc.get("shipment_delivery_note") or []):
            dnname = dn.get("delivery_note")
            if not dnname:
                continue
            rows = frappe.get_all(
                "Delivery Note Item",
                filters={"parent": dnname, "against_sales_order": ["!=", ""]},
                fields=["against_sales_order"], limit=1,
            )
            if rows:
                so = rows[0].against_sales_order
                break
        oid = _order_id_from_so(so)
        if not oid:
            return
        ts = doc.get("tracking_status")
        payload = {
            "awb_number": doc.get("awb_number"),
            "carrier": doc.get("carrier"),
            "carrier_service": doc.get("carrier_service"),
            "tracking_url": doc.get("tracking_url"),
            "tracking_status": ts,
            "delivered": str(ts or "").lower() == "delivered",
        }
        _deliver("order.tracking", oid, payload, "%s-%s" % (doc.name, method), "Shipment", doc.name)
    except Exception:
        frappe.log_error(title="medusync reverse Shipment hook failed", message=frappe.get_traceback())


def on_sales_invoice(doc, method=None):
    try:
        if not _guard():
            return
        oid = None
        for it in (doc.items or []):
            if it.get("sales_order"):
                oid = _order_id_from_so(it.sales_order)
                if oid:
                    break
        if not oid and doc.get("medusa_order_id"):
            oid = doc.get("medusa_order_id")
        if not oid:
            return
        cancelled = method == "on_cancel" or getattr(doc, "docstatus", 0) == 2
        if cancelled:
            status = "Cancelled"
        else:
            status = "Paid" if float(doc.get("outstanding_amount") or 0) <= 0 else "Unpaid"
        payload = {
            "invoice_number": doc.name,
            "invoice_date": str(doc.get("posting_date") or ""),
            "grand_total": float(doc.get("grand_total") or 0),
            "currency": doc.get("currency"),
            "status": status,
        }
        _deliver("order.invoiced", oid, payload, "%s-%s" % (doc.name, method), "Sales Invoice", doc.name)
    except Exception:
        frappe.log_error(title="medusync reverse SI hook failed", message=frappe.get_traceback())
