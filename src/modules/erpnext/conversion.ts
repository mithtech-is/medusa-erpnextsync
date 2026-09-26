import type { MedusaFieldType } from "./registry"

/**
 * Whether a Medusa field and a Frappe field can hold each other's values,
 * and which transform makes them.
 *
 * Auto-map applies a `safe` conversion without asking; a `review` one is
 * shown with its suggestion and left to the operator, because it loses
 * information or guesses at a shape (text into an Int truncates; a list
 * into text needs a separator somebody chose). `none` needs nothing;
 * `unmappable` is a pair that no scalar transform can make right.
 *
 * Pure, and the same table the mapper's warning reads.
 */

export type FrappeTypeGroup =
    | "text"
    | "float"
    | "int"
    | "check"
    | "date"
    | "datetime"
    | "time"
    | "json"
    | "table"
    | "unknown"

export type ConversionVerdict =
    | { kind: "none" }
    | { kind: "safe"; transform: string; why: string }
    | { kind: "review"; transform: string | null; why: string }
    | { kind: "unmappable"; why: string }

const TEXT_TYPES = new Set([
    "Data",
    "Small Text",
    "Text",
    "Long Text",
    "Text Editor",
    "Markdown Editor",
    "HTML Editor",
    "Code",
    "Link",
    "Dynamic Link",
    "Select",
    "Read Only",
    "Autocomplete",
    "Phone",
    "Barcode",
    "Color",
    "Attach",
    "Attach Image",
    "Signature",
    "Password",
    "Rating",
    "Icon",
    "Geolocation",
])

export function frappeTypeGroup(fieldtype: string | null | undefined): FrappeTypeGroup {
    const t = String(fieldtype ?? "").trim()
    if (!t) return "unknown"
    if (TEXT_TYPES.has(t)) return "text"
    if (t === "Float" || t === "Currency" || t === "Percent" || t === "Duration") return "float"
    if (t === "Int") return "int"
    if (t === "Check") return "check"
    if (t === "Date") return "date"
    if (t === "Datetime") return "datetime"
    if (t === "Time") return "time"
    if (t === "JSON") return "json"
    if (t === "Table" || t === "Table MultiSelect") return "table"
    return "unknown"
}

const none: ConversionVerdict = { kind: "none" }
const safe = (transform: string, why: string): ConversionVerdict => ({ kind: "safe", transform, why })
const review = (transform: string | null, why: string): ConversionVerdict => ({ kind: "review", transform, why })
const unmappable = (why: string): ConversionVerdict => ({ kind: "unmappable", why })

/**
 * Medusa → Frappe (`push`) or Frappe → Medusa (`pull`).
 *
 * A Medusa `id` is text on the wire and moves like a string. A Medusa
 * `json` is an object; a Frappe `JSON` field holds a string.
 */
export function suggestConversion(args: {
    direction: "push" | "pull"
    medusaType: MedusaFieldType | string | null | undefined
    frappeType: string | null | undefined
}): ConversionVerdict {
    const m = String(args.medusaType ?? "string") as MedusaFieldType
    const f = frappeTypeGroup(args.frappeType)
    if (f === "table") return unmappable("a child table needs a dedicated handler")
    if (f === "unknown") return none

    if (args.direction === "push") return pushVerdict(m, f)
    return pullVerdict(m, f)
}

function pushVerdict(m: MedusaFieldType, f: FrappeTypeGroup): ConversionVerdict {
    switch (m) {
        case "string":
        case "id":
            switch (f) {
                case "text":
                case "time":
                    return none
                case "float":
                    return safe("number", "text into a number; a value that is not numeric is skipped")
                case "int":
                    return review("integer", "text into an Int truncates any decimals")
                case "check":
                    return review("check", "text into a tick box: only yes/no/true/false/0/1 convert")
                case "date":
                    return review("date_yyyy_mm_dd", "text into a Date: only a parseable date converts")
                case "datetime":
                    return review("datetime_frappe", "text into a Datetime: only a parseable datetime converts")
                case "json":
                    return review("json", "text into a JSON field is stored as a JSON string")
            }
            break
        case "number":
            switch (f) {
                case "float":
                    return none
                case "int":
                    return review("integer", "a number into an Int truncates any decimals")
                case "text":
                    return safe("text", "a number written as text")
                case "check":
                    return review("check", "a number into a tick box: 0 is off, anything else on")
                default:
                    return unmappable(`a number cannot become a ${f}`)
            }
        case "boolean":
            switch (f) {
                case "check":
                    return safe("check", "true/false as 1/0")
                case "text":
                    return safe("text", "true/false written as text")
                case "int":
                case "float":
                    return review("check", "true/false as 1/0 into a numeric field")
                default:
                    return unmappable(`a boolean cannot become a ${f}`)
            }
        case "datetime":
            switch (f) {
                case "datetime":
                    return safe("datetime_frappe", "in the ERPNext site's timezone")
                case "date":
                    return safe("date_yyyy_mm_dd", "the date part, in the ERPNext site's timezone")
                case "text":
                    return safe("date_iso", "as an ISO timestamp")
                default:
                    return unmappable(`a datetime cannot become a ${f}`)
            }
        case "array":
            switch (f) {
                case "json":
                    return safe("json", "the list as JSON")
                case "text":
                    return review("join:,", "a list into text needs a separator; comma is a guess")
                default:
                    return unmappable(`a list cannot become a ${f}`)
            }
        case "json":
            switch (f) {
                case "json":
                case "text":
                    return safe("json", "the object as a JSON string")
                default:
                    return unmappable(`an object cannot become a ${f}`)
            }
    }
    return none
}

function pullVerdict(m: MedusaFieldType, f: FrappeTypeGroup): ConversionVerdict {
    switch (m) {
        case "string":
        case "id":
            switch (f) {
                case "text":
                case "time":
                case "date":
                case "datetime":
                    return none
                case "float":
                case "int":
                case "check":
                    return safe("text", "a number written as text")
                case "json":
                    return none
            }
            break
        case "number":
            switch (f) {
                case "float":
                case "int":
                case "check":
                    return none
                case "text":
                    return safe("number", "text into a number; a value that is not numeric is skipped")
                default:
                    return unmappable(`a ${f} cannot become a number`)
            }
        case "boolean":
            switch (f) {
                case "check":
                    return safe("boolean", "1/0 as true/false")
                case "int":
                case "float":
                    return review("boolean", "a number into true/false: 0 is false, anything else true")
                case "text":
                    return review("boolean", "text into true/false: only yes/no/true/false/0/1 convert")
                default:
                    return unmappable(`a ${f} cannot become a boolean`)
            }
        case "datetime":
            switch (f) {
                case "datetime":
                case "date":
                    return safe("date_iso", "from the ERPNext site's timezone")
                case "text":
                    return review("date_iso", "text into a datetime: only a parseable value converts")
                default:
                    return unmappable(`a ${f} cannot become a datetime`)
            }
        case "array":
            switch (f) {
                case "json":
                    return safe("parse_json", "the JSON list")
                case "text":
                    return review("split:,", "text into a list needs a separator; comma is a guess")
                default:
                    return unmappable(`a ${f} cannot become a list`)
            }
        case "json":
            switch (f) {
                case "json":
                    return safe("parse_json", "the JSON object")
                case "text":
                    return review("parse_json", "text into an object: only valid JSON converts")
                default:
                    return unmappable(`a ${f} cannot become an object`)
            }
    }
    return none
}
