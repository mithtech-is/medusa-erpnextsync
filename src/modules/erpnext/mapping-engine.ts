/**
 * Generic transform engine that consumes an `erpnext_mapping` row and
 * a source object (either a Medusa entity or a Frappe doc) and emits
 * the corresponding payload for the other side.
 *
 * Why a dedicated engine vs. case-by-case handlers:
 *   The operator builds field-by-field pairs in the admin UI. The
 *   subscriber and pull cron consume those pairs identically — the
 *   only difference is `direction` (push vs pull). Pulling the
 *   transform logic out keeps both paths thin and lets us unit-test
 *   the gnarliest part of the system in isolation.
 *
 * Not in scope:
 *   - Calling Frappe or Medusa. The engine only transforms in
 *     memory. The push/pull callers handle I/O.
 *   - Schema validation. The Frappe side's REST layer rejects
 *     invalid payloads with a clear error which we capture into
 *     `erpnext_sync_event.last_error`.
 *
 * Transforms (string codes; matched case-insensitively):
 *   lowercase / uppercase / trim
 *   number / integer / boolean   — coerce; non-coercible → null
 *   json                         — JSON.stringify
 *   split:<sep>                  — string → array via sep ("split:,")
 *   join:<sep>                   — array → string via sep ("join: | ")
 *   prefix:<s> / suffix:<s>      — concat constants
 *   slice:<start>:<end>          — substring or array slice
 *   date_iso / date_yyyy_mm_dd   — Date or parseable string → ISO / YYYY-MM-DD
 *
 * Any unknown transform is a no-op (logged, not thrown — operator
 * mistakes shouldn't break the whole sync).
 *
 * Composite templates:
 *   A pair's `medusa_path` may be a template instead of a dot-path:
 *     "{first_name} {last_name}"     → ERPNext `customer_name`
 *     "{addresses.0.address_1}, {addresses.0.address_2}"
 *   Missing parts drop their adjacent separators (see renderTemplate),
 *   so a customer with no last name syncs as "Manoj", not "Manoj ".
 *
 *   Within a slot, `||` means "first of these that has a value":
 *     "{metadata.kyc_pan_number || metadata.pan_number}"
 *   which is how a renamed field keeps working without listing two
 *   rows against the same ERPNext column.
 *
 *   Templates are PUSH-ONLY — they have no inverse, so the pull path
 *   skips them rather than writing a joined string back into one of
 *   the source fields.
 */

/** Which way a whole mapping is allowed to move. */
export type MappingDirection = "push" | "pull" | "both"

/**
 * Which way ONE field is allowed to move. "none" is Don't Sync: the pair
 * stays documented in the mapping but moves in neither direction - how
 * "product images flow ERPNext to Medusa but never back" and "internal
 * cost never leaves" are expressed without deleting the pair and losing
 * the record of the decision.
 */
export type FieldDirection = MappingDirection | "none"

export type MappingFieldPair = {
    /**
     * Either a plain dot-path ("first_name") or a COMPOSITE TEMPLATE
     * ("{first_name} {last_name}") that stitches several Medusa fields
     * into the one column Frappe offers. See `renderTemplate`.
     *
     * A template is push-only by construction — see the pull branch in
     * `applyMapping`.
     */
    medusa_path: string
    erpnext_field: string
    /** Per-field direction override. Defaults to the parent mapping's
     *  `direction` when absent. */
    direction?: FieldDirection
    /** Optional transform code (see file-doc). Applied AFTER reading
     *  from the source and BEFORE writing to the target. */
    transform?: string | null
    /** Fallback value when the source field is missing/empty/null.
     *  Set to a static string/number/boolean or null. */
    default?: unknown
    /** When true, a missing source value short-circuits the whole
     *  mapping (caller skips with `required_missing` reason). When
     *  false (default), the target field is simply omitted. */
    required?: boolean
}

export type ApplyMappingArgs = {
    direction: "push" | "pull"
    /** The whole field_mappings array off the mapping row. */
    fields: MappingFieldPair[]
    /** Per-mapping direction (`push` | `pull` | `both`) from the row.
     *  Used as the default when a pair has no explicit direction. */
    mappingDirection: FieldDirection
    /** Source object. On push: the enriched Medusa entity (dot-paths).
     *  On pull: the Frappe doc (top-level field names). */
    source: Record<string, any>
}

export type ApplyMappingResult =
    | { ok: true; payload: Record<string, any>; skippedFields: string[] }
    | { ok: false; reason: string; field?: string }

/**
 * Apply one mapping's `field_mappings` to a source object, producing
 * a target payload suitable for the receiving side.
 */
export function applyMapping(args: ApplyMappingArgs): ApplyMappingResult {
    const payload: Record<string, any> = {}
    const skipped: string[] = []

    for (const pair of args.fields ?? []) {
        const effectiveDirection = pair.direction ?? args.mappingDirection
        if (!fieldFlowsInDirection(effectiveDirection, args.direction)) {
            // Operator opted this field out of the current sync
            // direction — leave the target untouched. NOT counted in
            // `skipped` because that's reserved for missing-value
            // skips that ops should see.
            continue
        }

        const sourcePath =
            args.direction === "push" ? pair.medusa_path : pair.erpnext_field
        const targetField =
            args.direction === "push" ? pair.erpnext_field : pair.medusa_path

        if (!sourcePath || !targetField) {
            skipped.push(targetField || sourcePath || "<unset>")
            continue
        }

        // A composite template joins several Medusa fields into one
        // Frappe column. It has no inverse, so on pull we can't decide
        // which part of "Manoj Bhat" is the first name — skip rather
        // than write the whole string into `first_name`.
        if (isTemplatePath(pair.medusa_path)) {
            if (args.direction === "pull") {
                skipped.push(pair.erpnext_field)
                continue
            }
        }

        const raw = isTemplatePath(sourcePath)
            ? renderTemplate(sourcePath, args.source)
            : getByPath(args.source, sourcePath)
        let value: unknown = raw

        if (isEmpty(value)) {
            if (pair.default !== undefined) {
                value = pair.default
            } else if (pair.required) {
                return {
                    ok: false,
                    reason: "required_field_missing",
                    field: sourcePath,
                }
            } else {
                skipped.push(sourcePath)
                continue
            }
        }

        value = applyTransform(value, pair.transform)

        if (args.direction === "push") {
            // Frappe payloads are flat objects keyed by fieldname.
            // No dot-path expansion needed on the target side.
            payload[targetField] = value
        } else {
            // On pull we write back into Medusa with dot-paths so a
            // single mapping can land into `metadata.kyc_pan` etc.
            setByPath(payload, targetField, value)
        }
    }

    return { ok: true, payload, skippedFields: skipped }
}

/**
 * Resolve whether a per-field (or per-mapping) direction allows the
 * current sync direction to flow. "both" is permissive in either
 * direction; "push" and "pull" are exclusive; "none" (Don't Sync) blocks
 * both.
 */
function fieldFlowsInDirection(
    fieldDir: FieldDirection,
    runDir: "push" | "pull",
): boolean {
    if (fieldDir === "none") return false
    if (fieldDir === "both") return true
    return fieldDir === runDir
}

/**
 * True when a mapping's source is a composite template rather than a
 * plain dot-path — i.e. it contains at least one `{dot.path}` slot.
 */
export function isTemplatePath(path: unknown): boolean {
    return typeof path === "string" && /\{[^{}]+\}/.test(path)
}

/**
 * Render a composite template against a source object.
 *
 *   "{first_name} {last_name}"  + {first_name:"Manoj", last_name:"Bhat"}
 *     → "Manoj Bhat"
 *
 * The interesting case is a MISSING part. Naive interpolation leaves
 * the literal separators behind — a customer with no last name would
 * sync as `"Manoj "`, and `"{a}, {b}"` with no `a` would sync as
 * `", Bhat"`. Frappe stores that verbatim and an operator sees dirty
 * data they can't explain.
 *
 * So we render structurally: split into literal and placeholder chunks,
 * then keep a literal only when it actually sits between (or beside)
 * chunks that produced a value. That makes every part optional without
 * the caller writing conditionals.
 *
 * When NO placeholder resolves, the result is "" — which lets the
 * normal `default` / `required` handling in `applyMapping` take over
 * exactly as it would for an empty scalar.
 */
/**
 * Resolve one `{...}` slot, honouring the fallback operator.
 *
 *   {metadata.pan}                       → that path
 *   {metadata.kyc_pan || metadata.pan}   → first of the two that has a value
 *
 * Fallbacks exist because field names get renamed. When the store moved
 * `metadata.kyc_pan_number` → `metadata.pan_number`, the mapping kept
 * BOTH by listing two rows against the same ERPNext column and relying
 * on empty values being skipped. That works, but it reads as a
 * duplicate, it silently lets the later row win if both are ever
 * populated, and any tool that keys rows by target column (like the
 * autofill) quietly drops one of them. Saying "first of these" in a
 * single row states the intent instead of implying it.
 */
function resolveSlot(source: Record<string, any>, expression: string): unknown {
    const alternatives = expression.split("||")
    for (const alt of alternatives) {
        const value = getByPath(source, alt.trim())
        if (value !== null && value !== undefined && String(value).trim() !== "") {
            return value
        }
    }
    return undefined
}

/**
 * Every dot-path a template expression reads, in order. Used by the
 * pull query planner (which must request the underlying Frappe columns)
 * and by the admin UI to explain a combined row in words.
 */
export function templatePaths(template: string): string[] {
    const paths: string[] = []
    for (const [, slot] of template.matchAll(/\{([^{}]+)\}/g)) {
        for (const alt of slot.split("||")) {
            const trimmed = alt.trim()
            if (trimmed && !paths.includes(trimmed)) paths.push(trimmed)
        }
    }
    return paths
}

export function renderTemplate(
    template: string,
    source: Record<string, any>,
): string {
    type Chunk =
        | { kind: "literal"; text: string }
        | { kind: "slot"; text: string; empty: boolean }

    const chunks: Chunk[] = []
    const slotPattern = /\{([^{}]+)\}/g
    let cursor = 0
    let match: RegExpExecArray | null

    while ((match = slotPattern.exec(template)) !== null) {
        if (match.index > cursor) {
            chunks.push({
                kind: "literal",
                text: template.slice(cursor, match.index),
            })
        }
        const resolved = resolveSlot(source, match[1])
        const text =
            resolved === null || resolved === undefined
                ? ""
                : String(resolved).trim()
        chunks.push({ kind: "slot", text, empty: text.length === 0 })
        cursor = match.index + match[0].length
    }
    if (cursor < template.length) {
        chunks.push({ kind: "literal", text: template.slice(cursor) })
    }

    if (!chunks.some((c) => c.kind === "slot" && !c.empty)) return ""

    // Emit filled slots, re-joining them with exactly ONE separator each.
    //
    // Collapsing matters when a middle part drops out: "{a} {b} {c}" with
    // no `b` leaves two space literals queued, and emitting both (or
    // neither) gives "Manoj  Bhat" / "ManojBhat" instead of "Manoj Bhat".
    //
    // Literals before the FIRST slot are a prefix ("Mr {first_name}") and
    // are kept only when some slot eventually resolves. Literals queued
    // after a dropped slot are separators, never a prefix — otherwise
    // "{a}, {b}" with no `a` would render ", Bengaluru".
    const out: string[] = []
    let prefix = ""
    let seenAnySlot = false
    let emittedAny = false
    let pending: string[] = []

    for (const chunk of chunks) {
        if (chunk.kind === "literal") {
            if (seenAnySlot) pending.push(chunk.text)
            else prefix += chunk.text
            continue
        }
        seenAnySlot = true
        if (chunk.empty) continue

        if (!emittedAny) {
            if (prefix) out.push(prefix)
        } else {
            // The separator that immediately followed the previously
            // emitted value is the one the author meant to sit between
            // these two; any others queued up belong to dropped slots.
            out.push(pending[0] ?? "")
        }
        out.push(chunk.text)
        pending = []
        emittedAny = true
    }

    // A trailing literal ("{first_name} Jr") belongs to the last value.
    // Take the LAST queued one so a dropped slot's separator doesn't
    // shadow it in "{a} {b} Jr".
    if (pending.length) out.push(pending[pending.length - 1])

    return out.join("").replace(/\s+/g, " ").trim()
}

/**
 * Walk a dot-path through an object, returning undefined on any miss
 * (no throws). Array indices in the path are supported via numeric
 * tokens — "items.0.title" → object["items"][0]["title"].
 */
export function getByPath(src: any, path: string): unknown {
    if (src == null) return undefined
    if (!path) return src
    const tokens = path.split(".")
    let cur: any = src
    for (const tok of tokens) {
        if (cur == null) return undefined
        // Only treat a token as an array index when it's strictly digits
        // AND the current node is an array — otherwise Number("") === 0
        // (and other coercions) would spuriously index.
        if (Array.isArray(cur) && /^\d+$/.test(tok)) {
            cur = cur[Number(tok)]
        } else if (typeof cur === "object") {
            cur = cur[tok]
        } else {
            return undefined
        }
    }
    return cur
}

/**
 * Write a value into a target object via dot-path, creating any
 * missing intermediate plain objects. Doesn't materialise arrays —
 * a path with numeric tokens still creates an object at that level
 * (callers building pull payloads for Medusa want object shape, not
 * array shape).
 */
export function setByPath(
    target: Record<string, any>,
    path: string,
    value: unknown,
): void {
    if (!path) return
    const tokens = path.split(".")
    let cur: any = target
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i]
        // Never let a dot-path reach a prototype-pollution sink.
        if (tok === "__proto__" || tok === "prototype" || tok === "constructor") {
            return
        }
        if (i === tokens.length - 1) {
            cur[tok] = value
            return
        }
        if (cur[tok] == null || typeof cur[tok] !== "object") {
            cur[tok] = {}
        }
        cur = cur[tok]
    }
}

function isEmpty(v: unknown): boolean {
    if (v === null || v === undefined) return true
    if (typeof v === "string" && v.trim() === "") return true
    if (Array.isArray(v) && v.length === 0) return true
    return false
}

/**
 * Apply a transform code to a value. Returns the (possibly type-
 * changed) result. Unknown codes are no-ops. Failures within a
 * transform return the original value rather than throwing — operator
 * mistakes shouldn't break the whole sync run.
 */
export function applyTransform(value: unknown, code?: string | null): unknown {
    if (!code) return value
    const [name, ...rawArgs] = code.split(":")
    const arg = rawArgs.join(":")
    const norm = (name ?? "").trim().toLowerCase()

    try {
        switch (norm) {
            case "":
                return value
            case "lowercase":
                return typeof value === "string" ? value.toLowerCase() : value
            case "uppercase":
                return typeof value === "string" ? value.toUpperCase() : value
            case "trim":
                return typeof value === "string" ? value.trim() : value
            case "number": {
                const n = Number(value)
                return Number.isFinite(n) ? n : null
            }
            case "integer": {
                const n = Number(value)
                return Number.isFinite(n) ? Math.trunc(n) : null
            }
            case "boolean": {
                if (typeof value === "boolean") return value
                if (value == null) return false
                if (typeof value === "number") return value !== 0
                const s = String(value).trim().toLowerCase()
                if (["true", "1", "yes", "y", "on"].includes(s)) return true
                if (["false", "0", "no", "n", "off", ""].includes(s)) return false
                return Boolean(value)
            }
            case "json":
                return JSON.stringify(value)
            case "split":
                return typeof value === "string"
                    ? value.split(arg || ",")
                    : value
            case "join":
                return Array.isArray(value) ? value.join(arg || ",") : value
            case "prefix":
                return value == null ? value : `${arg}${value}`
            case "suffix":
                return value == null ? value : `${value}${arg}`
            case "slice": {
                const [a, b] = (arg || "").split(":")
                const start = Number(a)
                const end = b !== undefined && b !== "" ? Number(b) : undefined
                if (typeof value === "string") {
                    return value.slice(
                        Number.isFinite(start) ? start : 0,
                        Number.isFinite(end as number) ? (end as number) : undefined,
                    )
                }
                if (Array.isArray(value)) {
                    return value.slice(
                        Number.isFinite(start) ? start : 0,
                        Number.isFinite(end as number) ? (end as number) : undefined,
                    )
                }
                return value
            }
            case "date_iso": {
                const d = value instanceof Date ? value : new Date(value as any)
                return Number.isNaN(d.getTime()) ? null : d.toISOString()
            }
            case "date_yyyy_mm_dd": {
                const d = value instanceof Date ? value : new Date(value as any)
                if (Number.isNaN(d.getTime())) return null
                return d.toISOString().slice(0, 10)
            }
            default:
                // Unknown transform — leave the value untouched. We
                // could throw, but a typo in the admin form
                // shouldn't pin every sync run.
                return value
        }
    } catch {
        return value
    }
}
