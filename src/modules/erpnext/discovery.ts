/**
 * Medusa-side field discovery — where the mapper's left column comes from.
 *
 * Why this exists
 * ---------------
 * The two sides of this connector were asymmetric. ERPNext fields are
 * derived live from `frappe.get_meta(doctype)`, so a field added by an
 * app installed this morning shows up in the picker with its label and
 * type and nothing is maintained by hand. Medusa fields were a curated
 * `paths` array in `registry.ts` — seventeen hand-written lists. A field
 * nobody listed was invisible (mappable by typing the path, but never
 * offered), a new column in a Medusa release never appeared, and a
 * client's own module had no list at all.
 *
 * This module closes that gap. `describeModel` reads the module's own
 * mikro-orm metadata, which is the runtime form of the DML definition in
 * `models/*.ts`, and returns one descriptor per column. That covers core
 * modules and custom ones identically, because both register their models
 * the same way.
 *
 * Everything here is PURE — no container, no ORM, no I/O. The caller
 * hands in a plain metadata object; `discovery-runtime.ts` is the thin
 * impure half that fetches it. That keeps the interesting part (the walk,
 * the type mapping, the merge) testable with no Medusa process running.
 *
 * The three sources, in the order they are trusted
 * ------------------------------------------------
 *   model   — the mikro-orm metadata. Complete and never stale, but it
 *             describes the stored row, not the enriched object the fetch
 *             adapter actually produces.
 *   curated — `registry.ts`'s `paths`. Editorial: good labels, considered
 *             types, `suggested_transform` hints, and enriched paths that
 *             only exist because a fetch adapter loads a relation. Kept
 *             for exactly those, and it wins where the two overlap.
 *   record  — a real row, walked. The fallback for a model that has no
 *             mikro-orm metadata, and the only source that sees what an
 *             enriched object really carries.
 *
 * Deliberately NOT done here
 * --------------------------
 *   - To-many relations are offered as a single `array` field and are not
 *     descended into. A dotted path cannot address one row inside a
 *     collection, so `addresses.city` would produce a mapping that never
 *     resolves. Child rows are a handler's job (the same reason
 *     `autofill.ts` skips Frappe's `Table` fieldtypes).
 *   - Nothing here decides what to map. It produces the field list the
 *     picker and the autofill matcher read; the matching ladder stays in
 *     `autofill.ts`.
 */

import type { MedusaFieldDescriptor, MedusaFieldType } from "./registry"

/** One property as mikro-orm reports it in `getMetadata().getAll()`. */
export type OrmPropertyMeta = {
    name: string
    /** For a scalar, the column type ("string", "JsonType", "date"). For a
     *  relation, the target class name — which is why `kind` and not `type`
     *  is what distinguishes the two. */
    type?: string
    /** "scalar" for a column; "m:1" / "1:1" / "1:m" / "m:n" for a relation. */
    kind?: string
    /** Target class name on a relation. Same value as `targetMeta.className`
     *  but present even when the target has not been resolved yet. */
    entity?: string
    /** Set on the foreign-key half of a relation pair. Medusa's DML emits
     *  both halves — `collection` (the object) and `collection_id` (the key)
     *  — as `m:1` properties pointing at the same target, and only this
     *  flag tells them apart. The row carries a plain id string here. */
    mapToPk?: boolean
    nullable?: boolean
    primary?: boolean
    hidden?: boolean
    /** A column default. Present means the store fills this in itself. */
    default?: unknown
    /** The SQL form of the same — `now()`, `'draft'`. */
    defaultRaw?: string
    /** mikro-orm writes this on insert (the `created_at` / `updated_at`
     *  hooks), so no mapping can be expected to supply it. */
    onCreate?: unknown
    targetMeta?: { className?: string }
}

export type OrmEntityMeta = {
    className: string
    properties: Record<string, OrmPropertyMeta>
}

export type FieldSource = "model" | "curated" | "record"

export type DiscoveredField = MedusaFieldDescriptor & {
    source: FieldSource
    /** False for a column the ORM marks NOT NULL. The mapper badges these
     *  so an operator can see which pull targets must resolve to a value. */
    nullable?: boolean
    /** True when the path crosses a module link rather than a column.
     *  Enriching one costs a `query.graph` expansion on every push. */
    relation?: boolean
    /**
     * A value has to be supplied for this one, by a mapped source or a
     * fixed value, or the record cannot be created.
     *
     * NOT the same as `nullable === false`, which was the first guess and
     * was wrong in both directions: it flagged `id`, `created_at` and every
     * column with a default, and it flagged columns of *related* models
     * that this mapping never creates. See `isRequired`.
     */
    required?: boolean
    /**
     * The record this field belongs to, for grouping in a picker:
     * "Billing address" for `billing_address.city`, "" for the entity's
     * own columns. Derived from the path.
     */
    group?: string
    /**
     * Hidden from the picker unless asked for: bookkeeping columns, a
     * related record's own foreign keys, and the second name of something
     * the list already offers once. See `annotateForPicker`.
     */
    advanced?: boolean
}

export type DescribeOptions = {
    /** How many to-one relations deep to follow. 1 by default: enough for
     *  `sales_channel.name`, shallow enough that an order does not emit a
     *  four-figure path list. */
    maxDepth?: number
}

// ── Type mapping ─────────────────────────────────────────────────────

const ORM_TYPE_TO_FIELD_TYPE: Record<string, MedusaFieldType> = {
    string: "string",
    text: "string",
    character: "string",
    enum: "string",
    EnumType: "string",
    TextType: "string",
    StringType: "string",
    uuid: "string",
    boolean: "boolean",
    BooleanType: "boolean",
    number: "number",
    integer: "number",
    smallint: "number",
    bigint: "number",
    float: "number",
    double: "number",
    decimal: "number",
    numeric: "number",
    BigNumberRawType: "number",
    date: "datetime",
    Date: "datetime",
    datetime: "datetime",
    DateType: "datetime",
    DateTimeType: "datetime",
    json: "json",
    JsonType: "json",
    array: "array",
    ArrayType: "array",
}

function mapOrmType(prop: OrmPropertyMeta): MedusaFieldType {
    if (prop.primary && prop.name === "id") return "id"
    if (prop.name.endsWith("_id")) return "id"
    const t = prop.type ?? ""
    return ORM_TYPE_TO_FIELD_TYPE[t] ?? "string"
}

const TO_MANY = new Set(["1:m", "m:n"])
const TO_ONE = new Set(["m:1", "1:1"])

/**
 * Must an operator map this field for a record to be creatable?
 *
 * Four things disqualify a NOT NULL column, and all four appear on a
 * Medusa product:
 *   primary            `id` is generated.
 *   a default          `status` is 'draft', `discountable` is true — the
 *                      store answers for them.
 *   an onCreate hook   `created_at` / `updated_at` are written on insert.
 *   not at the root    `collection.title` is mandatory on ProductCollection,
 *                      not on the product this mapping creates.
 *
 * What survives on Product is `title` and `handle` — which is exactly what
 * Medusa refuses a product without.
 */
function isRequired(prop: OrmPropertyMeta, depth: number): boolean {
    if (depth > 0) return false
    if (prop.nullable !== false) return false
    if (prop.primary) return false
    if (prop.default !== undefined || prop.defaultRaw !== undefined) return false
    if (prop.onCreate !== undefined) return false
    return true
}

// ── Labels ───────────────────────────────────────────────────────────

/**
 * `default_address.postal_code` → "Default address › Postal code".
 * Only a starting point — a curated label always wins over this.
 */
export function humanizePath(path: string): string {
    return path
        .split(".")
        .map((seg) =>
            seg
                .replace(/_id$/, " id")
                .replace(/_/g, " ")
                .replace(/^./, (c) => c.toUpperCase()),
        )
        .join(" › ")
}

// ── The model walk ───────────────────────────────────────────────────

/**
 * Every mappable path on `rootModel`, derived from the module's own ORM
 * metadata. Returns `[]` for a model the module does not define, which is
 * the caller's signal to fall back to `describeRecord`.
 */
export function describeModel(
    entities: Record<string, OrmEntityMeta>,
    rootModel: string,
    opts: DescribeOptions = {},
): DiscoveredField[] {
    const maxDepth = opts.maxDepth ?? 1
    const out: DiscoveredField[] = []

    const walk = (modelName: string, prefix: string, depth: number, seen: Set<string>) => {
        const meta = entities?.[modelName]
        if (!meta) return

        for (const prop of Object.values(meta.properties ?? {})) {
            if (prop.hidden) continue

            const path = prefix ? `${prefix}.${prop.name}` : prop.name
            const ref = prop.kind

            if (ref && TO_MANY.has(ref)) {
                out.push({
                    path,
                    label: humanizePath(path),
                    type: "array",
                    source: "model",
                    relation: true,
                    nullable: prop.nullable ?? true,
                })
                continue
            }

            if (ref && TO_ONE.has(ref) && prop.mapToPk) {
                // The key half of a relation pair. Descending it would offer
                // `collection_id.handle`, which resolves against a string and
                // never produces a value.
                out.push({
                    path,
                    label: humanizePath(path),
                    type: "id",
                    source: "model",
                    nullable: prop.nullable ?? true,
                    ...(prefix ? { relation: true } : {}),
                })
                continue
            }

            if (ref && TO_ONE.has(ref)) {
                const target = prop.targetMeta?.className ?? prop.entity ?? prop.type
                // A relation object itself is not a mappable value, so it is
                // not emitted — only the columns underneath it are.
                if (!target || depth >= maxDepth || seen.has(target)) continue
                walk(target, path, depth + 1, new Set([...seen, target]))
                continue
            }

            out.push({
                path,
                label: humanizePath(path),
                type: mapOrmType(prop),
                source: "model",
                nullable: prop.nullable ?? true,
                ...(isRequired(prop, depth) ? { required: true } : {}),
                ...(prefix ? { relation: true } : {}),
            })
        }
    }

    walk(rootModel, "", 0, new Set([rootModel]))
    return out
}

// ── The record walk (fallback) ───────────────────────────────────────

function typeOfValue(value: unknown): MedusaFieldType {
    if (value === null || value === undefined) return "string"
    if (Array.isArray(value)) return "array"
    if (value instanceof Date) return "datetime"
    switch (typeof value) {
        case "boolean":
            return "boolean"
        case "number":
            return "number"
        case "object":
            return "json"
        default:
            // An ISO timestamp is a string to JavaScript but a date to an
            // operator, and Medusa serialises every `created_at` this way.
            return typeof value === "string" && ISO_DATE.test(value) ? "datetime" : "string"
    }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/

/**
 * Every path present in one real record. Used when a model has no ORM
 * metadata, and as the only way to see paths that exist on the enriched
 * object rather than on the stored row.
 */
export function describeRecord(
    record: Record<string, any>,
    opts: DescribeOptions = {},
): DiscoveredField[] {
    if (!record || typeof record !== "object" || Array.isArray(record)) return []

    const maxDepth = opts.maxDepth ?? 1
    const out: DiscoveredField[] = []

    const walk = (node: Record<string, any>, prefix: string, depth: number) => {
        for (const [key, value] of Object.entries(node)) {
            const path = prefix ? `${prefix}.${key}` : key
            const type = typeOfValue(value)

            out.push({
                path,
                label: humanizePath(path),
                type,
                source: "record",
                ...(prefix ? { relation: true } : {}),
            })

            const descend =
                type === "json" &&
                value !== null &&
                !(value instanceof Date) &&
                depth < maxDepth
            if (descend) walk(value, path, depth + 1)
        }
    }

    walk(record, "", 0)
    return out
}

// ── The merge ────────────────────────────────────────────────────────

/**
 * One field list from the curated and derived halves.
 *
 * Curated entries come first and in their own order — that is the list
 * operators already know, and it puts the identity field at the top where
 * `registry.ts` put it. Everything discovered but never curated follows,
 * alphabetically, so a new Medusa column appears in a predictable place
 * rather than wherever the ORM happened to report it.
 *
 * A curated path the model does not expose is kept, not dropped: enriched
 * paths like `sales_channel.name` exist because a fetch adapter loads that
 * relation, and removing them would take working mappings out of the picker.
 */
export function mergeFieldSources(
    derived: DiscoveredField[],
    curated: MedusaFieldDescriptor[],
): DiscoveredField[] {
    const derivedByPath = new Map(derived.map((f) => [f.path, f]))
    const curatedPaths = new Set(curated.map((c) => c.path))

    const fromCurated: DiscoveredField[] = curated.map((c) => {
        const d = derivedByPath.get(c.path)
        return {
            ...d,
            ...c,
            source: "curated",
            ...(d
                ? { nullable: d.nullable, relation: d.relation, required: d.required }
                : {}),
        }
    })

    const discoveries = derived
        .filter((f) => !curatedPaths.has(f.path))
        .sort((a, b) => a.path.localeCompare(b.path))

    return annotateForPicker([...fromCurated, ...discoveries])
}

// ── The picker's view ────────────────────────────────────────────────

const BOOKKEEPING = new Set(["created_at", "updated_at", "deleted_at", "metadata"])

/**
 * What a person picking a field should see first.
 *
 * Discovery is complete, which is the point of it, and completeness is
 * what made the list unreadable: every related record brought its
 * timestamps, its metadata and its foreign keys, and the same thing
 * appeared twice under two names — `billing_address_id` from the column
 * and `billing_address.id` from the relation. Nothing is dropped; the
 * noise is marked `advanced` and each field is given the record it
 * belongs to, so a picker can group and fold.
 *
 * A curated entry is editorial and is never marked, nor is anything a
 * record cannot be created without.
 */
export function annotateForPicker(fields: DiscoveredField[]): DiscoveredField[] {
    const paths = new Set(fields.map((f) => f.path))
    const curated = new Set(fields.filter((f) => f.source === "curated").map((f) => f.path))
    return fields.map((f) => {
        const dot = f.path.lastIndexOf(".")
        const prefix = dot >= 0 ? f.path.slice(0, dot) : ""
        const tail = dot >= 0 ? f.path.slice(dot + 1) : f.path
        const group = prefix ? humanizePath(prefix) : ""
        let advanced = false
        if (!curated.has(f.path) && !f.required) {
            if (BOOKKEEPING.has(tail) || tail.startsWith("raw_")) {
                advanced = true
            } else if (prefix && tail === "id" && paths.has(`${prefix}_id`)) {
                // The relation's id is the column this record already carries.
                advanced = true
            } else if (!prefix && tail.endsWith("_id") && curated.has(`${tail.slice(0, -3)}.id`)) {
                // The editorial choice went the other way for this one.
                advanced = true
            } else if (prefix && tail !== "id" && tail.endsWith("_id")) {
                // A related record's own foreign keys are its business.
                advanced = true
            }
        }
        return { ...f, group, ...(advanced ? { advanced: true } : {}) }
    })
}
