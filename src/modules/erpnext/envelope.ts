import crypto from "crypto"

/**
 * The wire contract, version 2 — the Medusa half.
 *
 * `medusync/envelope.py` is the mirror of this file; the two must agree
 * field for field, so change them together. What v2 adds over v1:
 *
 *   v          2. Absent means a v1 sender, which still parses.
 *   origin     who sent it: system, site_id, and a correlation_id carried
 *              unchanged through a causal chain.
 *   kind       what the body holds: "event", "mapped", or "mapping".
 *   echo_of    set when this message was caused by an inbound write from
 *              the named system+site. The far side drops what it
 *              recognises as its own, which is what breaks a sync loop
 *              once the round trip crosses a worker and an in-request
 *              guard flag can no longer help.
 *
 * v1 keys are still emitted (`id` alongside `event_id`, `data` for the
 * event shape) so a receiver that has not been upgraded keeps working
 * through a rolling deploy.
 */

export const ENVELOPE_VERSION = 2

/** This system's name in `origin.system`. The Frappe app sends "erpnext". */
export const SYSTEM = "medusa"

/**
 * A signed body carrying a `ts` outside this window is refused. `ts` sits
 * inside the signed body, so it cannot be re-dated without breaking the
 * signature.
 */
export const REPLAY_WINDOW_SECONDS = 300

export const KIND_EVENT = "event"
export const KIND_MAPPED = "mapped"
export const KIND_MAPPING = "mapping"

export type EnvelopeKind = typeof KIND_EVENT | typeof KIND_MAPPED | typeof KIND_MAPPING

export const nowTs = (): number => Math.floor(Date.now() / 1000)

export function newCorrelationId(): string {
    return crypto.randomUUID().replace(/-/g, "")
}

/** The `echo_of` form: `<system>:<site_id>`. */
export function originRef(system: string, siteId: string): string {
    return `${system}:${siteId}`
}

export type BuildArgs = {
    event: string
    event_id: string
    site_id: string
    kind?: EnvelopeKind
    correlation_id?: string | null
    echo_of?: string | null
    ts?: number
    /** A rehearsal: the receiver checks everything and writes nothing. */
    dry_run?: boolean
    // kind=event
    data?: any
    // kind=mapped
    doctype?: string
    key_field?: string
    key_value?: any
    payload?: Record<string, any>
    mapping_id?: string
    mapping_name?: string
    allow_create?: boolean
    allow_update?: boolean
    // kind=mapping
    mapping?: Record<string, any>
}

/** Compose an outbound envelope. Only the keys the `kind` needs are set. */
export function build(args: BuildArgs): Record<string, any> {
    const kind = args.kind ?? KIND_EVENT
    const env: Record<string, any> = {
        v: ENVELOPE_VERSION,
        kind,
        event: args.event,
        event_id: args.event_id,
        // v1 receivers read `id` on the mapped path and `event_id` on the
        // event path. Send both; the cost is a duplicated string.
        id: args.event_id,
        ts: args.ts ?? nowTs(),
        origin: {
            system: SYSTEM,
            site_id: args.site_id,
            correlation_id: args.correlation_id || newCorrelationId(),
        } as Record<string, any>,
    }
    if (args.echo_of) {
        env.origin.echo_of = args.echo_of
    }
    if (args.dry_run) {
        // Only present when true, so a receiver that predates the flag
        // sees exactly the body it has always seen.
        env.dry_run = true
    }
    if (kind === KIND_MAPPED) {
        env.doctype = args.doctype
        env.key_field = args.key_field
        env.key_value = args.key_value
        env.payload = args.payload ?? {}
        env.allow_create = args.allow_create !== false
        env.allow_update = args.allow_update !== false
        if (args.mapping_id) env.mapping_id = args.mapping_id
        if (args.mapping_name) env.mapping_name = args.mapping_name
    } else if (kind === KIND_MAPPING) {
        env.mapping = args.mapping ?? {}
    } else {
        env.data = args.data ?? {}
    }
    return env
}

export type ParsedEnvelope = {
    version: number
    kind: EnvelopeKind
    event: string
    event_id: string
    ts: number | null
    origin_system: string | null
    origin_site_id: string | null
    correlation_id: string | null
    echo_of: string | null
    dry_run: boolean
    data: any
    doctype: string | null
    key_field: string | null
    key_value: any
    payload: Record<string, any> | null
    mapping: Record<string, any> | null
    mapping_id: string | null
    mapping_name: string | null
    allow_create: boolean
    allow_update: boolean
    raw: Record<string, any>
}

/** A v1 body has no `kind`; its shape says which path it took. */
function inferKind(raw: Record<string, any>): EnvelopeKind {
    if (raw?.mapping != null) return KIND_MAPPING
    if (raw?.doctype && raw?.payload != null) return KIND_MAPPED
    return KIND_EVENT
}

export function parse(raw: Record<string, any> | null | undefined): ParsedEnvelope {
    const body = raw ?? {}
    const origin =
        body.origin && typeof body.origin === "object" ? (body.origin as Record<string, any>) : {}
    const versionNum = Number(body.v)
    const tsNum = Number(body.ts)
    return {
        version: Number.isFinite(versionNum) ? versionNum : 1,
        kind: (body.kind as EnvelopeKind) || inferKind(body),
        event: String(body.event ?? "").trim(),
        event_id: String(body.event_id ?? body.id ?? "").trim(),
        ts: body.ts != null && Number.isFinite(tsNum) ? tsNum : null,
        origin_system: origin.system ?? null,
        origin_site_id: origin.site_id ?? null,
        correlation_id: origin.correlation_id ?? null,
        echo_of: origin.echo_of ?? null,
        dry_run: body.dry_run === true,
        data: body.data !== undefined ? body.data : body.doc,
        doctype: (body.doctype && String(body.doctype).trim()) || null,
        key_field: (body.key_field && String(body.key_field).trim()) || null,
        key_value: body.key_value,
        payload: body.payload ?? null,
        mapping: body.mapping ?? null,
        mapping_id: body.mapping_id ?? null,
        mapping_name: body.mapping_name ?? null,
        // absent flags mean permitted, which is exactly how v1 behaved
        allow_create: body.allow_create !== false,
        allow_update: body.allow_update !== false,
        raw: body,
    }
}

/**
 * Replay protection. A body with no `ts` is accepted for backward
 * compatibility; one that carries a `ts` must be inside the window.
 */
export function isFresh(env: ParsedEnvelope, window = REPLAY_WINDOW_SECONDS): boolean {
    if (env.ts == null) return true
    return Math.abs(nowTs() - env.ts) <= window
}

/**
 * True when this message is our own change coming back to us.
 *
 * Two ways that shows: the sender explicitly tagged it as caused by one
 * of our sites (`echo_of`), or the envelope claims to originate from this
 * system at one of our own sites.
 */
export function isEcho(env: ParsedEnvelope, ourSiteIds: Iterable<string>): boolean {
    const ours = new Set(ourSiteIds ?? [])
    if (env.echo_of) {
        const [system, siteId] = String(env.echo_of).split(":")
        if (system === SYSTEM && siteId && ours.has(siteId)) return true
    }
    if (env.origin_system === SYSTEM && env.origin_site_id && ours.has(env.origin_site_id)) {
        return true
    }
    return false
}
