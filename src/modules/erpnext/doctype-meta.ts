/**
 * The fields of one ERPNext DocType as the site actually runs it.
 *
 * `/api/resource/DocType/<name>` returns the DocType as shipped. A site
 * then customises it two ways, and both live in other doctypes: a
 * Custom Field adds a column, a Property Setter changes one property of
 * an existing field — most often `reqd`, which is exactly what a push
 * rehearsal needs to know. Merging the three here, in one pure function,
 * keeps the rule testable without a Frappe.
 */

export type MetaField = {
    fieldname: string
    label: string
    fieldtype: string
    reqd?: number
    options?: string | null
    in_list_view?: number
    hidden?: number
    read_only?: number
    /** Frappe's own default — the autofill uses it to fill a mandatory
     *  field that has no Medusa counterpart. */
    default?: string | null
    /** Present when Frappe derives the value from a Link; such a field is
     *  never writable and the autofill skips it. */
    fetch_from?: string | null
}

export type PropertySetterRow = {
    field_name?: string | null
    property?: string | null
    value?: string | null
    property_type?: string | null
    doctype_or_field?: string | null
}

/** Layout-only fieldtypes with no value. */
const NON_VALUE = new Set(["Section Break", "Column Break", "Tab Break", "HTML", "Heading", "Button"])

/** Field properties a Property Setter may change that the mapper reads. */
const NUMERIC_PROPS = new Set(["reqd", "hidden", "read_only", "in_list_view"])
const TEXT_PROPS = new Set(["label", "options", "default", "fetch_from"])

export function mergeDoctypeMeta(args: {
    baseFields: any[]
    customFields?: any[]
    propertySetters?: PropertySetterRow[]
}): MetaField[] {
    // Custom Field overrides baseline on a fieldname collision, the same
    // precedence as Frappe's in-process meta resolver.
    const merged = new Map<string, any>()
    for (const f of args.baseFields ?? []) {
        if (f?.fieldname) merged.set(f.fieldname, { ...f })
    }
    for (const f of args.customFields ?? []) {
        if (f?.fieldname) merged.set(f.fieldname, { ...f })
    }
    // A Property Setter is the site's edit of one property; it wins over
    // both. Only DocField setters name a field.
    for (const ps of args.propertySetters ?? []) {
        if (ps?.doctype_or_field && ps.doctype_or_field !== "DocField") continue
        const target = ps?.field_name ? merged.get(ps.field_name) : undefined
        const prop = ps?.property ?? ""
        if (!target || !prop) continue
        if (NUMERIC_PROPS.has(prop)) target[prop] = Number(ps.value ?? 0) ? 1 : 0
        else if (TEXT_PROPS.has(prop)) target[prop] = ps.value ?? null
    }
    return Array.from(merged.values())
        .filter((f) => f.fieldname && !NON_VALUE.has(f.fieldtype))
        .map((f) => ({
            fieldname: f.fieldname,
            label: f.label ?? f.fieldname,
            fieldtype: f.fieldtype,
            reqd: f.reqd ?? 0,
            options: f.options ?? null,
            in_list_view: f.in_list_view ?? 0,
            hidden: f.hidden ?? 0,
            read_only: f.read_only ?? 0,
            default: f.default ?? null,
            fetch_from: f.fetch_from ?? null,
        }))
}
