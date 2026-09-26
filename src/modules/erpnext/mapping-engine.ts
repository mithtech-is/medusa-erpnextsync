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
 *   text                         — scalar → string
 *   number / integer / boolean   — coerce; a value that will not → skip
 *   check                        — boolean-ish → 1 / 0 (a Frappe Check)
 *   decimal:<places>             — number rounded to that many places
 *   json / parse_json            — JSON.stringify / JSON.parse
 *   map:a=b,c=d                  — value translation; the shared
 *                                  `transform` runs it in reverse on pull
 *   phone[:REGION]               — E.164, via libphonenumber; invalid → skip
 *   split:<sep>                  — string → array via sep ("split:,")
 *   join:<sep>                   — array → string via sep ("join: | ")
 *   prefix:<s> / suffix:<s>      — concat constants
 *   slice:<start>:<end>          — substring or array slice
 *   date_iso                     — → ISO timestamp (a naive Frappe value is
 *                                  read in the site's timezone)
 *   date_yyyy_mm_dd              — → YYYY-MM-DD in the site's timezone
 *   datetime_frappe              — → YYYY-MM-DD HH:mm:ss in the site's timezone
 *
 * A coercing transform that cannot coerce SKIPS the field — it is listed
 * in `skippedFields` with the reason in `failures` — and never writes null
 * over the target. Any unknown transform is a no-op.
 *
 * A pair may carry `transform_push` and `transform_pull`; `transform` is
 * the fallback for both. Likewise a fixed value per direction (`constant`
 * on push, `constant_pull` on pull) and a default per direction
 * (`default_push` / `default_pull`, falling back to `default`).
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

import { parsePhoneNumberFromString } from "libphonenumber-js/min"

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
     *  from the source and BEFORE writing to the target. The fallback for
     *  both directions when `transform_push` / `transform_pull` are absent. */
    transform?: string | null
    transform_push?: string | null
    transform_pull?: string | null
    /** Fallback value when the source field is missing/empty/null, for
     *  both directions unless a per-direction default is set. */
    default?: unknown
    default_push?: unknown
    default_pull?: unknown
    /**
     * A fixed value written to `erpnext_field` on every push, with no
     * Medusa source at all. `medusa_path` is empty on such a pair.
     *
     * Not the same as `default`, which fills in for a mapped source that
     * happened to be empty. This exists for ERPNext fields that must carry
     * a value and have no counterpart in the store: `Item.item_group` and
     * `Item.stock_uom` are mandatory Links with no default, and nothing in
     * a Medusa product corresponds to either.
     */
    constant?: unknown
    /** A fixed value written to `medusa_path` on every pull — every pulled
     *  product published, tagged with its source, put in a sales channel.
     *  `erpnext_field` may be empty on such a pair. */
    constant_pull?: unknown
    /** When true, a missing source value short-circuits the whole
     *  mapping (caller skips with `required_missing` reason). When
     *  false (default), the target field is simply omitted. */
    required?: boolean
}

/** What the coercing transforms need to know about the deployment. */
export type TransformOptions = {
    /** IANA zone of the ERPNext site, for naive Frappe datetimes. UTC when unset. */
    timezone?: string | null
    /** ISO 3166 region the `phone` transform assumes for national numbers. */
    phoneRegion?: string | null
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
    options?: TransformOptions
}

export type FieldFailure = { field: string; transform: string; reason: string }

export type ApplyMappingResult =
    | {
          ok: true
          payload: Record<string, any>
          skippedFields: string[]
          /** Fields skipped because their transform could not coerce the
           *  value; also listed in `skippedFields`. */
          failures: FieldFailure[]
      }
    | { ok: false; reason: string; field?: string }

/** The transform a pair uses in one direction, and whether it was inherited
 *  from the shared `transform` (which runs a `map:` in reverse on pull). */
export function transformFor(
    pair: MappingFieldPair,
    direction: "push" | "pull",
): { code: string | null; inherited: boolean } {
    const own = direction === "push" ? pair.transform_push : pair.transform_pull
    if (own !== undefined && own !== null && String(own).trim() !== "") return { code: String(own), inherited: false }
    const shared = pair.transform
    if (shared !== undefined && shared !== null && String(shared).trim() !== "") return { code: String(shared), inherited: true }
    return { code: null, inherited: false }
}

/** The fixed value a pair writes in one direction, or undefined when it
 *  reads a source instead. */
export function fixedFor(pair: MappingFieldPair, direction: "push" | "pull"): unknown {
    return direction === "push" ? pair.constant : pair.constant_pull
}

/** The default a pair falls back to in one direction, or undefined. */
export function defaultFor(pair: MappingFieldPair, direction: "push" | "pull"): unknown {
    const own = direction === "push" ? pair.default_push : pair.default_pull
    return own !== undefined ? own : pair.default
}

/**
 * Apply one mapping's `field_mappings` to a source object, producing
 * a target payload suitable for the receiving side.
 */
export function applyMapping(args: ApplyMappingArgs): ApplyMappingResult {
    const payload: Record<string, any> = {}
    const skipped: string[] = []
    const failures: FieldFailure[] = []
    const ctxBase = { direction: args.direction, ...(args.options ?? {}) }

    const write = (target: string, value: unknown) => {
        if (args.direction === "push") {
            // Frappe payloads are flat objects keyed by fieldname.
            payload[target] = value
        } else {
            // On pull we write back into Medusa with dot-paths so a
            // single mapping can land into `metadata.kyc_pan` etc.
            setByPath(payload, target, value)
        }
    }

    for (const pair of args.fields ?? []) {
        const effectiveDirection = pair.direction ?? args.mappingDirection
        if (!fieldFlowsInDirection(effectiveDirection, args.direction)) {
            // Operator opted this field out of the current sync
            // direction — leave the target untouched. NOT counted in
            // `skipped` because that's reserved for missing-value
            // skips that ops should see.
            continue
        }

        const targetField =
            args.direction === "push" ? pair.erpnext_field : pair.medusa_path
        const { code, inherited } = transformFor(pair, args.direction)
        const ctx = { ...ctxBase, invert: inherited && args.direction === "pull" }

        // A fixed value has no source to read, so it is settled before any
        // of the path handling below — which would otherwise reject it for
        // having an empty source path.
        const fixed = fixedFor(pair, args.direction)
        if (fixed !== undefined) {
            if (!targetField) {
                skipped.push("<unset>")
                continue
            }
            // A row turned into a fixed value but never filled in has
            // nothing to send. Writing "" would overwrite whatever the
            // far side holds with a blank, so leave the field out of
            // the payload entirely and say so: this is exactly the
            // "moved nothing unexpectedly" the operator reads `skipped`
            // for.
            if (!constantHasValue(fixed)) {
                skipped.push(targetField)
                continue
            }
            const coerced = coerce(fixed, code, ctx)
            if (coerced.ok === false) {
                skipped.push(targetField)
                failures.push({ field: targetField, transform: code ?? "", reason: coerced.reason })
                continue
            }
            write(targetField, coerced.value)
            continue
        }
        const sourcePath =
            args.direction === "push" ? pair.medusa_path : pair.erpnext_field

        // A pair fixed in the OTHER direction usually has nothing to read
        // or write in this one (a push constant has no Medusa path). Not a
        // skip worth reporting: a constant never moves the other way by
        // design. A pair that names both a source and a target here still
        // flows.
        const otherFixed = fixedFor(pair, args.direction === "push" ? "pull" : "push") !== undefined
        if (otherFixed && (!sourcePath || !targetField)) continue

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
            const fallback = defaultFor(pair, args.direction)
            if (fallback !== undefined) {
                value = fallback
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

        const coerced = coerce(value, code, ctx)
        if (coerced.ok === false) {
            // Never write null over the target for a value that would not
            // convert; leave the field alone and say why.
            skipped.push(targetField)
            failures.push({ field: targetField, transform: code ?? "", reason: coerced.reason })
            continue
        }
        write(targetField, coerced.value)
    }

    return { ok: true, payload, skippedFields: skipped, failures }
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
 * True when a pair's fixed value is actually something to send.
 *
 * `undefined` is "this pair reads a store field"; a blank or whitespace
 * string is "somebody turned the row into a fixed value and has not said
 * what the value is yet". Neither is a source, and the difference matters
 * because a pair that merely *claims* a fixed value would otherwise count
 * as filling a mandatory field — silencing the very warnings that exist to
 * catch it (see `unmetRequired`).
 *
 * `null` IS a value: it clears the field on the far side, which is a thing
 * a mapping can legitimately want to do.
 */
export function constantHasValue(constant: unknown): boolean {
    if (constant === undefined) return false
    if (typeof constant === "string") return constant.trim() !== ""
    return true
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

export type CoerceContext = TransformOptions & {
    direction?: "push" | "pull"
    /** Run a `map:` the other way round — the shared `transform` on pull. */
    invert?: boolean
}

export type CoerceResult = { ok: true; value: unknown } | { ok: false; reason: string }

const BOOL_TRUE = new Set(["true", "1", "yes", "y", "on"])
const BOOL_FALSE = new Set(["false", "0", "no", "n", "off"])

function asBoolean(value: unknown): boolean | null {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : null
    if (typeof value === "string") {
        const s = value.trim().toLowerCase()
        if (BOOL_TRUE.has(s)) return true
        if (BOOL_FALSE.has(s)) return false
    }
    return null
}

function asNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value === "boolean") return value ? 1 : 0
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value.trim())
        return Number.isFinite(n) ? n : null
    }
    return null
}

/** `map:a=b,c=d` → pairs, in order. Keys and values are trimmed text. */
export function parseMapTransform(arg: string): Array<[string, string]> {
    return String(arg ?? "")
        .split(",")
        .map((entry) => entry.split("="))
        .filter((kv) => kv.length >= 2)
        .map(([k, ...v]) => [k.trim(), v.join("=").trim()] as [string, string])
}

const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/

/** Offset of `zone` at the instant `utcMs`, in ms east of UTC. */
function zoneOffsetMs(utcMs: number, zone: string): number {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: zone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(new Date(utcMs))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0")
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"))
    return asUtc - Math.floor(utcMs / 1000) * 1000
}

/** A naive wall-clock time in `zone` → the instant. */
function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, zone: string): number {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms)
    const first = guess - zoneOffsetMs(guess, zone)
    // A second pass settles a wall time near a DST change.
    return guess - zoneOffsetMs(first, zone)
}

/**
 * Read a date-ish value as an instant. A naive Frappe string
 * ("2026-09-26 10:00:00.123456") is read in the site's timezone; anything
 * with an offset, a Date, or an epoch is taken as it is.
 */
export function parseDateValue(value: unknown, zone?: string | null): Date | null {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
    if (typeof value === "number") return Number.isFinite(value) ? new Date(value) : null
    if (typeof value !== "string" || !value.trim()) return null
    const m = NAIVE_DATETIME.exec(value.trim())
    if (m) {
        const [, y, mo, d, h, mi, sec, frac] = m
        const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0
        const tz = zone && zone.trim() ? zone.trim() : "UTC"
        try {
            return new Date(zonedToUtc(Number(y), Number(mo), Number(d), Number(h ?? 0), Number(mi ?? 0), Number(sec ?? 0), ms, tz))
        } catch {
            return null
        }
    }
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
}

/** An instant as "YYYY-MM-DD HH:mm:ss" (or the date part) in `zone`. */
export function formatInZone(date: Date, zone: string | null | undefined, withTime: boolean): string {
    const tz = zone && zone.trim() ? zone.trim() : "UTC"
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
    }).formatToParts(date)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00"
    const ymd = `${get("year")}-${get("month")}-${get("day")}`
    return withTime ? `${ymd} ${get("hour")}:${get("minute")}:${get("second")}` : ymd
}

/**
 * Apply a transform code to a value, saying so when it cannot.
 *
 * Shape-changing transforms (split, join, prefix, …) pass a value of the
 * wrong shape through untouched, as before. Coercing ones — number,
 * integer, boolean, check, decimal, text, phone, map, parse_json and the
 * dates — answer `ok: false` for a value that will not convert, and the
 * engine skips the field rather than write null. Unknown codes are no-ops.
 */
export function coerce(value: unknown, code: string | null | undefined, ctx: CoerceContext = {}): CoerceResult {
    if (!code) return { ok: true, value }
    const [name, ...rawArgs] = code.split(":")
    const arg = rawArgs.join(":")
    const norm = (name ?? "").trim().toLowerCase()
    const fail = (reason: string): CoerceResult => ({ ok: false, reason })
    const ok = (v: unknown): CoerceResult => ({ ok: true, value: v })

    try {
        switch (norm) {
            case "":
                return ok(value)
            case "lowercase":
                return ok(typeof value === "string" ? value.toLowerCase() : value)
            case "uppercase":
                return ok(typeof value === "string" ? value.toUpperCase() : value)
            case "trim":
                return ok(typeof value === "string" ? value.trim() : value)
            case "text": {
                if (value === null || value === undefined) return fail("nothing to write as text")
                if (typeof value === "object") return fail("a list or object is not text; use json or join")
                return ok(String(value))
            }
            case "number": {
                const n = asNumber(value)
                return n === null ? fail(`"${String(value)}" is not a number`) : ok(n)
            }
            case "integer": {
                const n = asNumber(value)
                return n === null ? fail(`"${String(value)}" is not a number`) : ok(Math.trunc(n))
            }
            case "decimal": {
                const n = asNumber(value)
                if (n === null) return fail(`"${String(value)}" is not a number`)
                const places = Math.max(0, Math.min(10, Number(arg) || 0))
                return ok(Number(n.toFixed(places)))
            }
            case "boolean": {
                const b = asBoolean(value)
                return b === null ? fail(`"${String(value)}" is not a yes/no value`) : ok(b)
            }
            case "check": {
                const b = asBoolean(value)
                return b === null ? fail(`"${String(value)}" is not a yes/no value`) : ok(b ? 1 : 0)
            }
            case "json":
                return ok(JSON.stringify(value))
            case "parse_json": {
                if (typeof value !== "string") return ok(value)
                try {
                    return ok(JSON.parse(value))
                } catch {
                    return fail("not valid JSON")
                }
            }
            case "map": {
                const pairs = parseMapTransform(arg)
                if (!pairs.length) return fail("map: has no a=b pairs")
                const needle = String(value ?? "").trim()
                const hit = pairs.find(([from, to]) => (ctx.invert ? to : from) === needle)
                if (!hit) return fail(`no mapping for "${needle}"`)
                return ok(ctx.invert ? hit[0] : hit[1])
            }
            case "phone": {
                if (value === null || value === undefined || String(value).trim() === "") return fail("no phone number")
                const region = (arg || ctx.phoneRegion || "").trim().toUpperCase()
                const parsed = parsePhoneNumberFromString(String(value), region ? (region as any) : undefined)
                if (!parsed || !parsed.isValid()) return fail(`"${String(value)}" is not a valid phone number${region ? ` for ${region}` : ""}`)
                return ok(parsed.number)
            }
            case "split":
                return ok(typeof value === "string" ? value.split(arg || ",") : value)
            case "join":
                return ok(Array.isArray(value) ? value.join(arg || ",") : value)
            case "prefix":
                return ok(value == null ? value : `${arg}${value}`)
            case "suffix":
                return ok(value == null ? value : `${value}${arg}`)
            case "slice": {
                const [a, b] = (arg || "").split(":")
                const start = Number(a)
                const end = b !== undefined && b !== "" ? Number(b) : undefined
                if (typeof value === "string" || Array.isArray(value)) {
                    return ok(
                        (value as any).slice(
                            Number.isFinite(start) ? start : 0,
                            Number.isFinite(end as number) ? (end as number) : undefined,
                        ),
                    )
                }
                return ok(value)
            }
            case "date_iso": {
                const d = parseDateValue(value, ctx.timezone)
                return d ? ok(d.toISOString()) : fail(`"${String(value)}" is not a date`)
            }
            case "date_yyyy_mm_dd": {
                const d = parseDateValue(value, ctx.timezone)
                return d ? ok(formatInZone(d, ctx.timezone, false)) : fail(`"${String(value)}" is not a date`)
            }
            case "datetime_frappe": {
                const d = parseDateValue(value, ctx.timezone)
                return d ? ok(formatInZone(d, ctx.timezone, true)) : fail(`"${String(value)}" is not a date`)
            }
            default:
                // Unknown transform — leave the value untouched. A typo in
                // the admin form shouldn't pin every sync run.
                return ok(value)
        }
    } catch (err: any) {
        return fail(err?.message ?? "transform failed")
    }
}

/**
 * Apply a transform code to a value. The result, or `undefined` when the
 * transform could not coerce it — callers that need the reason use
 * `coerce`. Kept for the tests and the studio; the engine uses `coerce`.
 */
export function applyTransform(value: unknown, code?: string | null, ctx: CoerceContext = {}): unknown {
    const r = coerce(value, code, ctx)
    return r.ok ? r.value : undefined
}

/** A field the receiving side will not accept a record without. */
export type RequiredField = { name: string; label?: string }

/**
 * Which mandatory fields on the receiving side has nobody arranged to fill?
 *
 * A mapping that leaves one blank still saves, still rehearses in the sense
 * that it produces a payload, and then fails on the first real record with
 * the far side rejecting the document — at which point the cause is a log
 * line rather than a form. Checking it during the rehearsal puts the
 * failure where somebody can act on it, and the rehearsal is what gates
 * switching the mapping on.
 *
 * A field counts as covered when some pair writes it in the direction being
 * checked and that pair actually has something to write: a source path, a
 * fixed value for that direction that is filled in, or a default for when
 * the source is empty. A pair switched to "fixed value" and left blank
 * does NOT cover anything — it is the case this check exists for.
 */
export function unmetRequired(args: {
    direction: "push" | "pull"
    fields: MappingFieldPair[]
    mappingDirection: MappingDirection
    /** Mandatory fields on whichever side is receiving. */
    required: RequiredField[]
}): RequiredField[] {
    const covered = new Set<string>()

    for (const pair of args.fields ?? []) {
        const effective = pair.direction ?? args.mappingDirection
        if (!fieldFlowsInDirection(effective, args.direction)) continue

        const fixed = fixedFor(pair, args.direction)
        const hasSource =
            fixed !== undefined
                ? constantHasValue(fixed)
                : defaultFor(pair, args.direction) !== undefined ||
                  Boolean(args.direction === "push" ? pair.medusa_path : pair.erpnext_field)
        if (!hasSource) continue

        const target =
            args.direction === "push" ? pair.erpnext_field : pair.medusa_path
        if (target) covered.add(target)
    }

    return (args.required ?? []).filter((f) => !covered.has(f.name))
}
