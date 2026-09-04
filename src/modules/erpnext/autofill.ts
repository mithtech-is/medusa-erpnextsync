/**
 * Generic (Medusa entity × Frappe doctype) → field-pair suggester.
 *
 * Why this exists
 * ---------------
 * `canonical-mappings.ts` only covers six hand-written (entity,
 * doctype) pairs. Pick anything else — Sales Invoice, Item, Address,
 * a site's own custom doctype — and the mapping editor hands you an
 * empty grid and expects you to remember ~120 Frappe fieldnames.
 *
 * This module closes that gap: given the doctype's field meta (from
 * `getDoctypeMeta`) and the entity's curated dot-paths (from
 * `registry.ts`), it emits one ready-to-edit pair per field that
 * matters, with a best-guess Medusa source attached and a confidence
 * label so the operator knows which rows to double-check.
 *
 * Everything here is PURE — no Frappe, no container, no I/O. The
 * service method feeds it two arrays and persists nothing. That keeps
 * the interesting half (the matcher) unit-testable without a live ERP.
 *
 * Matching ladder, highest confidence first
 * -----------------------------------------
 *   canonical — a canonical-mappings.ts entry already pairs these two
 *   composite — the Frappe field is a whole-name/whole-address style
 *               field and the entity exposes the parts separately, so
 *               we emit a TEMPLATE ("{first_name} {last_name}") rather
 *               than dropping one of them on the floor
 *   exact     — normalised names are identical (email_id ↔ email once
 *               the trailing `id` and `custom_` prefix are stripped)
 *   synonym   — both sides land in the same SYNONYM_GROUP
 *   strong    — token-set Jaccard ≥ 0.75
 *   weak      — token-set Jaccard ≥ 0.40 (shown, but flagged)
 *   none      — no guess; the row is still emitted when the Frappe
 *               field is mandatory, because a blank mandatory field is
 *               exactly what the operator needs to see
 *
 * Deliberately NOT done here
 * --------------------------
 *   - We never mark a suggested pair `required: true`. `required` makes
 *     the engine abort the whole record when the source is empty, and
 *     a wrong guess would then silently stop a customer syncing. Frappe
 *     rejecting the payload with a legible error is the better failure
 *     mode; the UI shows a "mandatory" badge instead.
 *   - Child tables (`Table` / `Table MultiSelect`) are skipped. They
 *     need array-of-rows handling that a flat dot-path pair can't
 *     express — a customer's child rows are done by a
 *     dedicated handler, not by the generic mapper.
 */

import type { MedusaFieldDescriptor } from "./registry"

/** One field as returned by `getDoctypeMeta`. */
export type DoctypeFieldMeta = {
    fieldname: string
    label?: string
    fieldtype?: string
    reqd?: number
    options?: string | null
    hidden?: number
    read_only?: number
    /** Frappe's own default for the field — used to pre-fill the pair's
     *  `default` so a mandatory Select with no Medusa counterpart still
     *  produces a valid payload. */
    default?: string | null
    /** Set when Frappe computes the value from a Link — never writable. */
    fetch_from?: string | null
}

export type AutofillConfidence =
    | "canonical"
    | "composite"
    | "exact"
    | "synonym"
    | "strong"
    | "weak"
    | "none"

export type AutofillRow = {
    erpnext_field: string
    erpnext_label: string
    fieldtype: string
    /** Mandatory on the Frappe side — the UI badges these red when the
     *  Medusa side is still blank. */
    reqd: boolean
    /** Dot-path, or a `{a} {b}` template for composite matches. */
    medusa_path: string
    transform: string | null
    default: unknown
    direction: "push" | "pull" | "both"
    confidence: AutofillConfidence
    /** Short human sentence for the row tooltip. */
    why: string
}

export type AutofillResult = {
    rows: AutofillRow[]
    /** Counts by confidence, for the status banner. */
    summary: Record<AutofillConfidence, number>
    /** Frappe fields we deliberately did not surface, with the reason —
     *  so "why isn't `items` in the list?" has an answer in the UI. */
    skipped: Array<{ fieldname: string; reason: string }>
}

// ── Field filters ────────────────────────────────────────────────────

/**
 * Columns Frappe owns outright. Mapping any of these either does
 * nothing or actively corrupts the doc (`name` is the identity key and
 * is configured separately as `key_erpnext_field`).
 */
const FRAPPE_RESERVED = new Set([
    "name",
    "owner",
    "creation",
    "modified",
    "modified_by",
    "docstatus",
    "idx",
    "parent",
    "parentfield",
    "parenttype",
    "doctype",
    "amended_from",
    "_user_tags",
    "_comments",
    "_assign",
    "_liked_by",
])

/** Fieldtypes a flat scalar pair cannot meaningfully write into. */
const UNMAPPABLE_FIELDTYPES = new Set([
    "Table",
    "Table MultiSelect",
    "Signature",
    "Geolocation",
    "Barcode",
    "Fold",
    "Image",
])

// ── Normalisation ────────────────────────────────────────────────────

/** Tokens that carry no matching signal on either side. */
const NOISE_TOKENS = new Set(["the", "of", "a", "an", "is", "has"])

/**
 * Token-level spelling unification. Applied AFTER splitting, so
 * `mobile_no` and `phone_number` both end up containing `number`.
 */
const TOKEN_ALIASES: Record<string, string> = {
    no: "number",
    nos: "number",
    num: "number",
    addr: "address",
    org: "organization",
    organisation: "organization",
    mob: "mobile",
    tel: "telephone",
    ph: "phone",
    amt: "amount",
    qty: "quantity",
    dt: "date",
    desc: "description",
    pincode: "postal",
    pin: "postal",
    zip: "postal",
    zipcode: "postal",
    postcode: "postal",
    province: "state",
    town: "city",
}

/**
 * Split a fieldname or dot-path leaf into comparable tokens.
 *
 * Handles Frappe's `custom_` prefix (a Custom Field's `custom_pan` is
 * the same concept as a baseline `pan`) and camelCase, and drops a
 * trailing `id` on multi-token names so `email_id` ↔ `email` matches
 * without needing a synonym entry.
 */
export function tokenize(raw: string): string[] {
    let tokens = String(raw ?? "")
        .replace(/^custom_/, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
        .filter((t) => !NOISE_TOKENS.has(t))
        .map((t) => TOKEN_ALIASES[t] ?? t)

    // `email_id` → `email`, but a bare `id` stays `id`.
    if (tokens.length > 1 && tokens[tokens.length - 1] === "id") {
        tokens = tokens.slice(0, -1)
    }
    return tokens
}

/** Canonical string form used for synonym-group lookup. */
export function normalizeName(raw: string): string {
    return tokenize(raw).join("_")
}

/**
 * A Medusa dot-path's *leaf* is what actually names the concept —
 * `metadata.kyc_pan` is a PAN, not a metadata. Numeric segments
 * (`addresses.0.city`) are array indexes and never meaningful.
 */
export function pathLeaf(path: string): string {
    const segments = String(path ?? "")
        .split(".")
        .filter((s) => s && !/^\d+$/.test(s))
    return segments[segments.length - 1] ?? ""
}

// ── Synonym groups ───────────────────────────────────────────────────

/**
 * Sets of names that mean the same thing across the two vocabularies.
 * Entries are normalised through `normalizeName` at module load, so
 * they can be written in whichever spelling reads best here.
 *
 * Keep these tight. A group that is too greedy (e.g. adding "title" to
 * the name group) produces confident-looking wrong mappings, which is
 * worse for an operator than an honest blank.
 */
const SYNONYM_GROUPS: string[][] = [
    ["email", "email_id", "email_address", "primary_email", "login_email"],
    [
        "phone",
        "mobile",
        "mobile_no",
        "phone_no",
        "contact_no",
        "telephone",
        "cell",
        "whatsapp_no",
    ],
    ["first_name", "given_name", "fname", "forename"],
    ["last_name", "surname", "family_name", "lname"],
    ["middle_name", "second_name"],
    // NB no `lead_name`: on ERPNext's Customer that is a Link to Lead,
    // not a person's name. The Link guard above already refuses it, but
    // leaving it out of the group keeps the intent obvious.
    [
        "full_name",
        "customer_name",
        "party_name",
        "supplier_name",
        "display_name",
        "person_name",
        "account_holder",
    ],
    ["company_name", "company", "organization", "business_name"],
    ["address_1", "address_line1", "address_line_1", "addr1", "address"],
    ["address_2", "address_line2", "address_line_2", "addr2"],
    ["city", "town"],
    ["state", "province", "region"],
    ["postal_code", "pincode", "pin_code", "zip", "zipcode", "postcode"],
    ["country", "country_code"],
    ["created_at", "creation", "created_on"],
    ["updated_at", "modified", "modified_on"],
    ["id", "medusa_id", "external_id", "reference_id", "client_id"],
    ["pan", "pan_no", "pan_number", "pan_card"],
    ["gstin", "gst_no", "gst_number"],
    ["amount", "grand_total", "total_amount", "net_amount"],
    ["quantity", "qty", "units"],
    ["rate", "unit_price", "price", "unit_rate"],
    ["currency", "currency_code"],
    ["description", "remarks", "notes"],
    ["handle", "slug", "route"],
    ["sku", "item_code"],
    ["ifsc", "ifsc_code", "branch_code"],
    ["account_number", "ac_number", "bank_account_no"],
]

/** normalised name → group index. Built once. */
const SYNONYM_INDEX: Map<string, number> = (() => {
    const m = new Map<string, number>()
    SYNONYM_GROUPS.forEach((group, i) => {
        for (const entry of group) {
            m.set(normalizeName(entry), i)
        }
    })
    return m
})()

function synonymGroupOf(name: string): number | null {
    const idx = SYNONYM_INDEX.get(normalizeName(name))
    return idx === undefined ? null : idx
}

// ── Composite rules ──────────────────────────────────────────────────

/**
 * Frappe fields that are one column but conceptually several Medusa
 * fields. When the entity exposes the parts, emit a template instead
 * of arbitrarily picking one part and losing the rest.
 *
 * This is the `<Customer table>, <{first name}+{second name}+{surname}>`
 * case: ERPNext's `customer_name` is a single Data field, Medusa keeps
 * `first_name` / `last_name` apart.
 *
 * `parts` are matched against the entity's declared paths; a rule fires
 * only when at least two parts are present (one part means the plain
 * scalar match is already correct and a template would just add noise).
 */
const COMPOSITE_RULES: Array<{
    /** Synonym-group anchor on the Frappe side. */
    anchor: string
    parts: string[]
    separator: string
    why: string
}> = [
    {
        anchor: "full_name",
        parts: ["first_name", "middle_name", "last_name"],
        separator: " ",
        why: "ERPNext keeps one name column; Medusa keeps the parts apart",
    },
    {
        anchor: "address_1",
        parts: ["addresses.0.address_1", "addresses.0.address_2"],
        separator: ", ",
        why: "ERPNext address line vs Medusa's two address lines",
    },
]

// ── Similarity ───────────────────────────────────────────────────────

/** Jaccard index over token sets. 1 = identical, 0 = disjoint. */
export function tokenSimilarity(a: string[], b: string[]): number {
    if (!a.length || !b.length) return 0
    const setA = new Set(a)
    const setB = new Set(b)
    let intersection = 0
    for (const t of setA) if (setB.has(t)) intersection++
    const union = setA.size + setB.size - intersection
    return union === 0 ? 0 : intersection / union
}

// ── The matcher ──────────────────────────────────────────────────────

/**
 * Canonical pairs keyed by `"<erpnext_field>::<direction>"`.
 *
 * The direction is part of the key because one ERPNext column can be
 * legitimately written by two different pairs running opposite ways
 * (a mapping may fill one ERPNext field from `handle` on pull and
 * from a metadata path on push). Keying by column alone loses one.
 */
export type CanonicalPairLookup = Map<
    string,
    { medusa_path: string; transform?: string | null; direction?: string }
>

/** Find a canonical pair for a column, preferring an exact
 *  direction match, then a two-way one, then whatever exists. */
function canonicalFor(canonical: CanonicalPairLookup, fieldname: string) {
    return (
        canonical.get(`${fieldname}::push`) ??
        canonical.get(`${fieldname}::both`) ??
        canonical.get(`${fieldname}::pull`) ??
        canonical.get(`${fieldname}::undefined`) ??
        canonical.get(fieldname)
    )
}

export type BuildAutofillArgs = {
    /** Field meta for the chosen doctype. */
    doctypeFields: DoctypeFieldMeta[]
    /** Curated dot-paths for the chosen Medusa entity. */
    entityPaths: MedusaFieldDescriptor[]
    /** Overall mapping direction — every emitted row inherits it unless
     *  it's a composite (which can only flow push-ward). */
    direction: "push" | "pull" | "both"
    /** Canonical pairs keyed by Frappe fieldname, when the (entity,
     *  doctype) combination has a canonical entry. */
    canonical?: CanonicalPairLookup
    /** `smart` (default) keeps mandatory fields plus anything matched;
     *  `all` keeps every writable field; `matched` keeps only guesses. */
    mode?: "smart" | "all" | "matched"
}

export function buildAutofill(args: BuildAutofillArgs): AutofillResult {
    const mode = args.mode ?? "smart"
    const canonical = args.canonical ?? new Map()
    const skipped: Array<{ fieldname: string; reason: string }> = []

    // Pre-tokenise the entity's paths once — the inner loop runs this
    // against every doctype field.
    const candidates = args.entityPaths.map((p) => ({
        descriptor: p,
        leaf: pathLeaf(p.path),
        tokens: tokenize(pathLeaf(p.path)),
        group: synonymGroupOf(pathLeaf(p.path)),
    }))
    const availablePaths = new Set(args.entityPaths.map((p) => p.path))

    const rows: AutofillRow[] = []

    for (const field of args.doctypeFields) {
        const fieldname = field.fieldname
        if (!fieldname) continue

        if (FRAPPE_RESERVED.has(fieldname)) {
            skipped.push({ fieldname, reason: "managed by Frappe" })
            continue
        }
        if (UNMAPPABLE_FIELDTYPES.has(field.fieldtype ?? "")) {
            skipped.push({
                fieldname,
                reason: `${field.fieldtype} needs a dedicated handler`,
            })
            continue
        }
        if (field.fetch_from) {
            skipped.push({
                fieldname,
                reason: `fetched from ${field.fetch_from}`,
            })
            continue
        }
        // `naming_series` is mandatory on many doctypes but is a Frappe
        // control, not data — its own default always applies.
        if (fieldname === "naming_series") {
            skipped.push({ fieldname, reason: "Frappe naming control" })
            continue
        }

        const match = bestMatch(field, candidates, availablePaths, canonical)

        const isMandatory = Boolean(field.reqd)
        const keep =
            mode === "all" ||
            (mode === "matched" && match.confidence !== "none") ||
            (mode === "smart" && (isMandatory || match.confidence !== "none"))
        if (!keep) {
            skipped.push({ fieldname, reason: "optional and unmatched" })
            continue
        }

        rows.push({
            erpnext_field: fieldname,
            erpnext_label: field.label || fieldname,
            fieldtype: field.fieldtype || "Data",
            reqd: isMandatory,
            medusa_path: match.medusa_path,
            transform: match.transform,
            // Only carry Frappe's own default across when we have no
            // Medusa source — otherwise the default would mask a real
            // value the moment the source is momentarily empty.
            default:
                !match.medusa_path && field.default ? field.default : undefined,
            direction: match.direction ?? args.direction,
            confidence: match.confidence,
            why: match.why,
        })
    }

    rows.sort(byInterest)

    const summary = {
        canonical: 0,
        composite: 0,
        exact: 0,
        synonym: 0,
        strong: 0,
        weak: 0,
        none: 0,
    } as Record<AutofillConfidence, number>
    for (const r of rows) summary[r.confidence]++

    return { rows, summary, skipped }
}

type MatchOutcome = {
    medusa_path: string
    transform: string | null
    confidence: AutofillConfidence
    why: string
    direction?: "push" | "pull" | "both"
}

function bestMatch(
    field: DoctypeFieldMeta,
    candidates: Array<{
        descriptor: MedusaFieldDescriptor
        leaf: string
        tokens: string[]
        group: number | null
    }>,
    availablePaths: Set<string>,
    canonical: CanonicalPairLookup,
): MatchOutcome {
    const fieldname = field.fieldname

    // 1. Canonical — a human already decided this pair.
    const canon = canonicalFor(canonical, fieldname)
    if (canon?.medusa_path) {
        return {
            medusa_path: canon.medusa_path,
            transform: canon.transform ?? null,
            confidence: "canonical",
            why: "from the shipped canonical mapping",
            direction: (canon.direction as any) ?? undefined,
        }
    }

    // 1b. Link fields take a RECORD NAME, not free text.
    //
    // ERPNext's Customer has a `lead_name` field — it looks like a
    // person's name and matches the name synonym group, but it is a
    // Link to Lead. Writing "Alex Fern" into it asks Frappe to
    // associate a Lead record called "Alex Fern", which either errors
    // or leaves a dangling reference. The same trap exists on every
    // doctype: item_group, stock_uom, territory, company.
    //
    // A heuristic can't know which record to point at, so it must not
    // guess. Canonical entries are exempt (checked above) — a human
    // deciding to map into a Link knows what they're targeting.
    const fieldtype = field.fieldtype ?? "Data"
    if (fieldtype === "Link" || fieldtype === "Dynamic Link") {
        return {
            medusa_path: "",
            transform: null,
            confidence: "none",
            why: field.options
                ? `links to a ${field.options} record — pick the field holding that record's name`
                : "links to another record — a guessed value would dangle",
        }
    }

    const fieldTokens = tokenize(fieldname)
    const fieldGroup = synonymGroupOf(fieldname)

    // 2. Composite — one Frappe column, several Medusa fields.
    if (fieldGroup !== null) {
        for (const rule of COMPOSITE_RULES) {
            if (synonymGroupOf(rule.anchor) !== fieldGroup) continue
            const present = rule.parts.filter((p) => availablePaths.has(p))
            if (!present.length) continue
            if (present.length === 1) {
                // Only one part exists on this entity, so a template
                // would be a one-slot template — same value, but
                // needlessly push-only. Emit the plain scalar and stay
                // two-way capable.
                return {
                    medusa_path: present[0],
                    transform: null,
                    confidence: "synonym",
                    why: `${rule.why} — only ${present[0]} is available here`,
                }
            }
            return {
                medusa_path: present
                    .map((p) => `{${p}}`)
                    .join(rule.separator),
                transform: null,
                confidence: "composite",
                why: rule.why,
                // A template cannot be run backwards, so a composite row
                // is push-only regardless of the mapping's direction.
                direction: "push",
            }
        }
    }

    // 3–5. Scalar ladder — walk every candidate, keep the strongest.
    let best: MatchOutcome | null = null
    let bestScore = -1

    for (const c of candidates) {
        let confidence: AutofillConfidence | null = null
        let why = ""

        if (normalizeName(fieldname) === normalizeName(c.leaf)) {
            confidence = "exact"
            why = `"${fieldname}" and "${c.descriptor.path}" normalise identically`
        } else if (
            fieldGroup !== null &&
            c.group !== null &&
            fieldGroup === c.group
        ) {
            confidence = "synonym"
            why = `"${fieldname}" and "${c.leaf}" are known synonyms`
        } else {
            const sim = tokenSimilarity(fieldTokens, c.tokens)
            if (sim >= 0.75) {
                confidence = "strong"
                why = `name similarity ${(sim * 100).toFixed(0)}%`
            } else if (sim >= 0.4) {
                confidence = "weak"
                why = `name similarity ${(sim * 100).toFixed(0)}% — please verify`
            }
        }
        if (!confidence) continue

        const score = CONFIDENCE_SCORE[confidence]
        // Ties go to the shorter path: a top-level `email` beats
        // `metadata.billing_email` for Frappe's `email_id`.
        const isBetter =
            score > bestScore ||
            (score === bestScore &&
                best !== null &&
                c.descriptor.path.length < best.medusa_path.length)
        if (isBetter) {
            bestScore = score
            best = {
                medusa_path: c.descriptor.path,
                transform: c.descriptor.suggested_transform ?? null,
                confidence,
                why,
            }
        }
    }

    if (best) return best

    return {
        medusa_path: "",
        transform: null,
        confidence: "none",
        why: field.reqd
            ? "mandatory in ERPNext — pick a Medusa source or set a default"
            : "no confident match",
    }
}

const CONFIDENCE_SCORE: Record<AutofillConfidence, number> = {
    canonical: 6,
    composite: 5,
    exact: 4,
    synonym: 3,
    strong: 2,
    weak: 1,
    none: 0,
}

/**
 * Sort so the operator's attention lands where it's needed: confident
 * rows first (they're just confirmations), then mandatory-but-blank
 * rows, then the rest alphabetically.
 */
function byInterest(a: AutofillRow, b: AutofillRow): number {
    const aBlankReqd = a.reqd && !a.medusa_path
    const bBlankReqd = b.reqd && !b.medusa_path
    if (aBlankReqd !== bBlankReqd) return aBlankReqd ? -1 : 1
    const diff =
        CONFIDENCE_SCORE[b.confidence] - CONFIDENCE_SCORE[a.confidence]
    if (diff !== 0) return diff
    return a.erpnext_field.localeCompare(b.erpnext_field)
}
