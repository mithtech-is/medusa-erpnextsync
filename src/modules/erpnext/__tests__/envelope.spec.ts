import { describe, expect, it } from "vitest"
import {
    ENVELOPE_VERSION,
    KIND_MAPPED,
    KIND_MAPPING,
    REPLAY_WINDOW_SECONDS,
    build,
    isEcho,
    isFresh,
    nowTs,
    parse,
} from "../envelope"

/**
 * The wire contract, from the Medusa side. `medusync/envelope.py` is the
 * mirror; these expectations are written to match it field for field, so
 * a change on one side that breaks the other fails here first.
 */
describe("envelope v2", () => {
    it("builds an event envelope with an origin", () => {
        const env = build({ event: "customer.created", event_id: "evt-1", site_id: "site-a", data: { id: "cus_1" } })
        expect(env.v).toBe(ENVELOPE_VERSION)
        expect(env.kind).toBe("event")
        expect(env.event_id).toBe("evt-1")
        // v1 receivers read `id`; both keys travel so a rolling upgrade works
        expect(env.id).toBe("evt-1")
        expect(env.origin.system).toBe("medusa")
        expect(env.origin.site_id).toBe("site-a")
        expect(env.origin.correlation_id).toBeTruthy()
        expect(env.data).toEqual({ id: "cus_1" })
    })

    it("keeps the v1 key names on a mapped push", () => {
        const env = build({
            event: "customer.created",
            event_id: "evt-2",
            site_id: "site-a",
            kind: KIND_MAPPED,
            doctype: "Customer",
            key_field: "email_id",
            key_value: "a@b.c",
            payload: { customer_name: "A" },
            allow_update: false,
        })
        expect(env.doctype).toBe("Customer")
        expect(env.key_field).toBe("email_id")
        expect(env.payload).toEqual({ customer_name: "A" })
        expect(env.allow_create).toBe(true)
        expect(env.allow_update).toBe(false)
    })

    it("carries a correlation id rather than minting a new one", () => {
        const env = build({ event: "x.y", event_id: "e", site_id: "s", correlation_id: "corr-1" })
        expect(env.origin.correlation_id).toBe("corr-1")
    })

    it("round-trips through parse", () => {
        const env = parse(build({ event: "x.y", event_id: "e", site_id: "s", data: { a: 1 } }))
        expect(env.version).toBe(2)
        expect(env.kind).toBe("event")
        expect(env.origin_system).toBe("medusa")
        expect(env.origin_site_id).toBe("s")
        expect(env.data).toEqual({ a: 1 })
    })

    it("reads a v1 event body", () => {
        const env = parse({ event: "customer.updated", event_id: "e1", data: { a: 1 } })
        expect(env.version).toBe(1)
        expect(env.kind).toBe("event")
        expect(env.event_id).toBe("e1")
        expect(env.origin_system).toBeNull()
    })

    it("recognises a v1 mapped body by its shape", () => {
        const env = parse({
            event: "customer.created",
            id: "e1",
            doctype: "Customer",
            key_field: "email_id",
            key_value: "a@b.c",
            payload: { customer_name: "A" },
        })
        expect(env.version).toBe(1)
        expect(env.kind).toBe(KIND_MAPPED)
        expect(env.event_id).toBe("e1")
        // absent flags default to permitted, exactly as v1 behaved
        expect(env.allow_create).toBe(true)
        expect(env.allow_update).toBe(true)
    })

    it("recognises a mapping-configuration body", () => {
        const env = parse(
            build({
                event: "mapping.upserted",
                event_id: "e1",
                site_id: "s",
                kind: KIND_MAPPING,
                mapping: { uid: "u1", version: 3 },
            }),
        )
        expect(env.kind).toBe(KIND_MAPPING)
        expect(env.mapping).toEqual({ uid: "u1", version: 3 })
    })

    it("refuses a stale timestamp and tolerates a missing one", () => {
        const fresh = parse(build({ event: "x.y", event_id: "e", site_id: "s" }))
        expect(isFresh(fresh)).toBe(true)
        const stale = parse({ event: "x.y", event_id: "e", ts: nowTs() - REPLAY_WINDOW_SECONDS - 30 })
        expect(isFresh(stale)).toBe(false)
        const future = parse({ event: "x.y", event_id: "e", ts: nowTs() + REPLAY_WINDOW_SECONDS + 30 })
        expect(isFresh(future)).toBe(false)
        // a v1 body without ts is still accepted
        expect(isFresh(parse({ event: "x.y", event_id: "e" }))).toBe(true)
    })

    it("spots our own change coming home", () => {
        const ours = ["site-a", "site-b"]
        const tagged = parse(build({ event: "x.y", event_id: "e", site_id: "s", echo_of: "medusa:site-a" }))
        expect(isEcho(tagged, ours)).toBe(true)

        const theirs = parse(build({ event: "x.y", event_id: "e", site_id: "s", echo_of: "medusa:site-z" }))
        expect(isEcho(theirs, ours)).toBe(false)

        // caused by ERPNext, not by us: apply it
        const fromErp = parse({ event: "x.y", event_id: "e", origin: { system: "erpnext", site_id: "site-a" } })
        expect(isEcho(fromErp, ours)).toBe(false)

        // claims to come from this system at one of our sites
        const selfOrigin = parse(build({ event: "x.y", event_id: "e", site_id: "site-b" }))
        expect(isEcho(selfOrigin, ours)).toBe(true)
    })

    it("treats an unknown site as somebody else's", () => {
        const env = parse(build({ event: "x.y", event_id: "e", site_id: "site-unknown" }))
        expect(isEcho(env, ["site-a"])).toBe(false)
    })
})

describe("a rehearsal on the wire", () => {
    it("is absent from an ordinary envelope", () => {
        // Absent rather than false, so a receiver that predates the flag
        // sees exactly the body it has always seen.
        const body = build({ event: "x.y", event_id: "e", site_id: "s" })
        expect("dry_run" in body).toBe(false)
        expect(parse(body).dry_run).toBe(false)
    })

    it("is stamped when asked for, and survives the round trip", () => {
        const body = build({ event: "x.y", event_id: "e", site_id: "s", dry_run: true })
        expect(body.dry_run).toBe(true)
        expect(parse(body).dry_run).toBe(true)
    })

    it("only a literal true counts", () => {
        // A truthy string on the wire is not a decision anyone made, and
        // the whole point of the flag is that the receiver does not write.
        expect(parse({ event: "x.y", event_id: "e", dry_run: "yes" }).dry_run).toBe(false)
        expect(parse({ event: "x.y", event_id: "e", dry_run: 1 }).dry_run).toBe(false)
        expect(parse({ event: "x.y", event_id: "e" }).dry_run).toBe(false)
    })

    it("rides along with a mapped push", () => {
        const body = build({
            event: "product.updated",
            event_id: "e",
            site_id: "s",
            kind: KIND_MAPPED,
            doctype: "Item",
            key_field: "item_code",
            key_value: "ABC",
            payload: { title: "x" },
            dry_run: true,
        })
        const parsed = parse(body)
        expect(parsed.dry_run).toBe(true)
        expect(parsed.kind).toBe(KIND_MAPPED)
    })
})
