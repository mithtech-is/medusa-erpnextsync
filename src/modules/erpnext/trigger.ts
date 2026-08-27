/**
 * Trigger conditions — "which records qualify", as a small safe
 * expression language.
 *
 * A mapping's `events` list decides which Medusa events are candidates.
 * This decides which of those candidate RECORDS actually sync. The
 * distinction matters: `customer.updated` fires on every profile touch,
 * but an operator may only want the record to reach ERPNext once KYC
 * clears, or once the customer has actually bought something.
 *
 * Why a bespoke language instead of `eval` / `new Function`
 * ---------------------------------------------------------
 * The expression is typed by an operator into an admin form and is
 * stored in the database. Evaluating it as JavaScript would mean any
 * admin-panel write — or anything that can reach that row — executes
 * arbitrary code inside the backend, with the container's credentials.
 * This grammar can only read dot-paths off the record and compare them,
 * so the worst a malicious or mistaken expression can do is match the
 * wrong records.
 *
 * Grammar
 * -------
 *     condition  := orExpr
 *     orExpr     := andExpr ("or" andExpr)*
 *     andExpr    := clause ("and" clause)*
 *     clause     := "(" orExpr ")" | "not" clause | comparison
 *     comparison := path OP value | path ("is set" | "is not set"
 *                                        | "is empty" | "is not empty"
 *                                        | "is true" | "is false")
 *     OP         := == | != | > | >= | < | <= | contains | starts with
 *                 | ends with
 *     value      := "quoted string" | number | true | false | null
 *
 * `and` binds tighter than `or`, as everywhere else. An empty condition
 * means "always" — that is the default and the common case.
 *
 * Examples:
 *     metadata.kyc_fully_approved_at is set
 *     orders_count > 0
 *     metadata.kyc_status == "approved" and email is not empty
 *     not metadata.is_test is true
 */

/** Flat rather than a discriminated union: callers want both fields and
 *  `error: undefined` on the happy path reads better than narrowing at
 *  every call site. `matched` is false whenever `ok` is false — a
 *  condition that doesn't parse matches nothing. */
export type TriggerResult = {
    ok: boolean
    matched: boolean
    error?: string
}

/** Presets offered in the admin, each expanding to a real expression so
 *  the operator can see (and then edit) what the preset actually does. */
export const TRIGGER_PRESETS: Array<{
    value: string
    label: string
    condition: string
    help: string
}> = [
    {
        value: "always",
        label: "Always — every matching event",
        condition: "",
        help: "Sync on every event listed above, with no further filtering.",
    },
    {
        value: "kyc_verified",
        label: "Only once KYC is fully verified",
        condition: "metadata.kyc_fully_approved_at is set",
        help: "Holds the record back until an admin has signed off every KYC check. This is what the code used to do for customers, unconditionally.",
    },
    {
        value: "has_purchased",
        label: "Only once they have bought something",
        condition: "orders_count > 0",
        help: "Waits for a completed order. Keeps browsers and abandoned signups out of ERPNext.",
    },
    {
        value: "has_value",
        label: "Only once the key field has a value",
        condition: "",
        help: "Fires as soon as the mapping's key field is populated — use with 'skip when nothing changed' to sync each value as it is entered.",
    },
    {
        value: "custom",
        label: "Custom condition",
        condition: "",
        help: "Write your own. Dot-paths are read off the record being synced.",
    },
]

export function presetCondition(preset: string): string {
    return TRIGGER_PRESETS.find((p) => p.value === preset)?.condition ?? ""
}

// ── Tokeniser ────────────────────────────────────────────────────────

type Token = { kind: "word" | "string" | "number" | "punct"; value: string }

function tokenize(input: string): Token[] {
    const tokens: Token[] = []
    let i = 0
    while (i < input.length) {
        const ch = input[i]
        if (/\s/.test(ch)) {
            i += 1
            continue
        }
        if (ch === "(" || ch === ")") {
            tokens.push({ kind: "punct", value: ch })
            i += 1
            continue
        }
        if (ch === '"' || ch === "'") {
            const quote = ch
            let out = ""
            i += 1
            while (i < input.length && input[i] !== quote) {
                // Backslash escapes so a value can contain its own quote.
                if (input[i] === "\\" && i + 1 < input.length) {
                    out += input[i + 1]
                    i += 2
                    continue
                }
                out += input[i]
                i += 1
            }
            if (i >= input.length) throw new Error("unterminated string literal")
            i += 1
            tokens.push({ kind: "string", value: out })
            continue
        }
        const twoChar = input.slice(i, i + 2)
        if (["==", "!=", ">=", "<="].includes(twoChar)) {
            tokens.push({ kind: "punct", value: twoChar })
            i += 2
            continue
        }
        if (ch === ">" || ch === "<") {
            tokens.push({ kind: "punct", value: ch })
            i += 1
            continue
        }
        const word = /^[A-Za-z0-9_.\-+@]+/.exec(input.slice(i))
        if (word) {
            const raw = word[0]
            tokens.push({
                kind: /^-?\d+(\.\d+)?$/.test(raw) ? "number" : "word",
                value: raw,
            })
            i += raw.length
            continue
        }
        throw new Error(`unexpected character "${ch}" at position ${i}`)
    }
    return tokens
}

// ── Parser → AST ─────────────────────────────────────────────────────

type Node =
    | { type: "or"; left: Node; right: Node }
    | { type: "and"; left: Node; right: Node }
    | { type: "not"; operand: Node }
    | { type: "compare"; path: string; op: string; value?: unknown }

const UNARY_OPS: Record<string, string> = {
    "is set": "is_set",
    "is not set": "is_not_set",
    "is empty": "is_empty",
    "is not empty": "is_not_empty",
    "is true": "is_true",
    "is false": "is_false",
}

const BINARY_WORD_OPS: Record<string, string> = {
    contains: "contains",
    "starts with": "starts_with",
    "ends with": "ends_with",
}

function parse(tokens: Token[]): Node {
    let pos = 0
    const peek = () => tokens[pos]
    const isWord = (w: string) =>
        peek()?.kind === "word" && peek()!.value.toLowerCase() === w

    function parseOr(): Node {
        let left = parseAnd()
        while (isWord("or")) {
            pos += 1
            left = { type: "or", left, right: parseAnd() }
        }
        return left
    }

    function parseAnd(): Node {
        let left = parseClause()
        while (isWord("and")) {
            pos += 1
            left = { type: "and", left, right: parseClause() }
        }
        return left
    }

    function parseClause(): Node {
        if (peek()?.kind === "punct" && peek()!.value === "(") {
            pos += 1
            const inner = parseOr()
            if (!(peek()?.kind === "punct" && peek()!.value === ")")) {
                throw new Error("missing closing bracket")
            }
            pos += 1
            return inner
        }
        if (isWord("not")) {
            pos += 1
            return { type: "not", operand: parseClause() }
        }
        return parseComparison()
    }

    function parseComparison(): Node {
        const head = peek()
        if (!head || head.kind !== "word") {
            throw new Error(
                head ? `expected a field path, got "${head.value}"` : "expression ended early",
            )
        }
        const path = head.value
        pos += 1

        // Word operators, greedy longest-match first so "is not set"
        // never parses as "is" followed by junk. Length 1 is in the list
        // because `contains` is a single word — leaving it out made
        // `contains` the one documented operator that didn't work.
        for (const len of [3, 2, 1]) {
            const phrase = tokens
                .slice(pos, pos + len)
                .map((t) => t.value.toLowerCase())
                .join(" ")
            if (UNARY_OPS[phrase]) {
                pos += len
                return { type: "compare", path, op: UNARY_OPS[phrase] }
            }
            if (BINARY_WORD_OPS[phrase]) {
                pos += len
                return { type: "compare", path, op: BINARY_WORD_OPS[phrase], value: readValue() }
            }
        }

        const op = peek()
        if (op?.kind === "punct" && ["==", "!=", ">", ">=", "<", "<="].includes(op.value)) {
            pos += 1
            return { type: "compare", path, op: op.value, value: readValue() }
        }
        throw new Error(
            `expected a comparison after "${path}" — try "${path} is set" or "${path} == \\"value\\""`,
        )
    }

    function readValue(): unknown {
        const t = peek()
        if (!t) throw new Error("expected a value")
        pos += 1
        if (t.kind === "string") return t.value
        if (t.kind === "number") return Number(t.value)
        const lower = t.value.toLowerCase()
        if (lower === "true") return true
        if (lower === "false") return false
        if (lower === "null") return null
        // A bare word is treated as a string so `status == approved`
        // works without quotes — the common operator mistake.
        return t.value
    }

    const ast = parseOr()
    if (pos < tokens.length) {
        throw new Error(`unexpected "${tokens[pos].value}" after a complete expression`)
    }
    return ast
}

// ── Evaluation ───────────────────────────────────────────────────────

function readPath(source: any, path: string): unknown {
    let cursor = source
    for (const token of path.split(".")) {
        if (cursor === null || cursor === undefined) return undefined
        if (typeof cursor !== "object") return undefined
        if (Array.isArray(cursor) && /^\d+$/.test(token)) {
            cursor = cursor[Number(token)]
            continue
        }
        // OWN properties only. Walking the prototype chain would make
        // `constructor is set` or `toString is set` quietly true on
        // every record — not exploitable on its own (nothing here can
        // call what it finds) but it is a condition matching for a
        // reason the operator never wrote, which is its own kind of
        // wrong. Records are plain data; inherited keys are never data.
        if (!Object.prototype.hasOwnProperty.call(cursor, token)) return undefined
        cursor = cursor[token]
    }
    return cursor
}

function isBlank(v: unknown): boolean {
    if (v === null || v === undefined) return true
    if (typeof v === "string") return v.trim() === ""
    if (Array.isArray(v)) return v.length === 0
    return false
}

function evaluate(node: Node, record: any): boolean {
    switch (node.type) {
        case "or":
            return evaluate(node.left, record) || evaluate(node.right, record)
        case "and":
            return evaluate(node.left, record) && evaluate(node.right, record)
        case "not":
            return !evaluate(node.operand, record)
        case "compare": {
            const actual = readPath(record, node.path)
            switch (node.op) {
                case "is_set":
                case "is_not_empty":
                    return !isBlank(actual)
                case "is_not_set":
                case "is_empty":
                    return isBlank(actual)
                case "is_true":
                    return actual === true || String(actual).toLowerCase() === "true"
                case "is_false":
                    return actual === false || String(actual).toLowerCase() === "false"
                case "==":
                    return looseEquals(actual, node.value)
                case "!=":
                    return !looseEquals(actual, node.value)
                case ">":
                case ">=":
                case "<":
                case "<=": {
                    const a = Number(actual)
                    const b = Number(node.value)
                    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
                    return node.op === ">" ? a > b
                        : node.op === ">=" ? a >= b
                        : node.op === "<" ? a < b
                        : a <= b
                }
                case "contains":
                    return String(actual ?? "").toLowerCase()
                        .includes(String(node.value ?? "").toLowerCase())
                case "starts_with":
                    return String(actual ?? "").toLowerCase()
                        .startsWith(String(node.value ?? "").toLowerCase())
                case "ends_with":
                    return String(actual ?? "").toLowerCase()
                        .endsWith(String(node.value ?? "").toLowerCase())
                default:
                    return false
            }
        }
    }
}

/** Compare without JS's surprises: "1" == 1 is fine, but null == false
 *  is not (an unset field must not equal `false`). */
function looseEquals(actual: unknown, expected: unknown): boolean {
    if (actual === expected) return true
    if (actual === null || actual === undefined) return expected === null
    if (typeof expected === "number") {
        const n = Number(actual)
        return Number.isFinite(n) && n === expected
    }
    if (typeof expected === "boolean") {
        return String(actual).toLowerCase() === String(expected)
    }
    return String(actual).toLowerCase() === String(expected).toLowerCase()
}

/**
 * Does this record satisfy the condition?
 *
 * An empty condition matches everything. A MALFORMED condition matches
 * NOTHING and reports the error — failing closed, because the operator
 * wrote the condition to hold records back, and a typo that silently
 * released everything would be the worse outcome.
 */
export function evaluateTrigger(condition: string | null | undefined, record: any): TriggerResult {
    const text = String(condition ?? "").trim()
    if (!text) return { ok: true, matched: true }
    try {
        return { ok: true, matched: evaluate(parse(tokenize(text)), record) }
    } catch (err: any) {
        return { ok: false, matched: false, error: err?.message ?? "invalid condition" }
    }
}

/** Validate without a record — used by the admin form to reject a bad
 *  expression at save time rather than at 3am when a sync stops. */
export function validateTrigger(condition: string | null | undefined): { ok: boolean; error?: string } {
    const text = String(condition ?? "").trim()
    if (!text) return { ok: true }
    try {
        parse(tokenize(text))
        return { ok: true }
    } catch (err: any) {
        return { ok: false, error: err?.message ?? "invalid condition" }
    }
}
