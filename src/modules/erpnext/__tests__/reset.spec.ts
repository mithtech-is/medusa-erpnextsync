import { describe, expect, it } from "vitest"

import {
    SECRET_BYTES,
    WINDOW_SECONDS,
    canVerify,
    expiresAt,
    hashSecret,
    isReady,
    newSecret,
    redacted,
    secondsLeft,
    secretMatches,
} from "../reset"

const live = (over: Record<string, any> = {}) => ({
    secret_hash: hashSecret("the-secret"),
    expires_at: expiresAt(),
    used_at: null,
    status: "pending",
    ...over,
})

describe("the secret itself", () => {
    it("is long enough to be worth nothing to guess", () => {
        // 32 bytes, base64url. Anything shorter is a password.
        expect(newSecret().length).toBeGreaterThanOrEqual(40)
        expect(SECRET_BYTES).toBe(32)
    })

    it("is different every time", () => {
        const seen = new Set(Array.from({ length: 50 }, () => newSecret()))
        expect(seen.size).toBe(50)
    })

    it("survives being pasted anywhere", () => {
        // base64url: no +, / or = to be mangled by a URL or a form.
        expect(newSecret()).toMatch(/^[A-Za-z0-9_-]+$/)
    })

    it("hashes the same way on both sides of the wire", () => {
        // Plain SHA-256 of the UTF-8 bytes, hex. medusync/reset.py does the
        // same; if these ever disagree no handshake can complete.
        expect(hashSecret("abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        )
    })

    it("is never recoverable from what is stored", () => {
        const secret = newSecret()
        expect(hashSecret(secret)).not.toContain(secret)
    })
})

describe("comparing one", () => {
    it("accepts the right secret", () => {
        expect(secretMatches("the-secret", hashSecret("the-secret"))).toBe(true)
    })

    it("refuses a wrong one", () => {
        expect(secretMatches("nearly-the-secret", hashSecret("the-secret"))).toBe(false)
    })

    it("refuses an empty one rather than matching an empty hash", () => {
        expect(secretMatches("", hashSecret(""))).toBe(false)
        expect(secretMatches("anything", null)).toBe(false)
        expect(secretMatches("anything", "")).toBe(false)
    })

    it("does not fall over on a stored value that is not a hash", () => {
        expect(secretMatches("the-secret", "not hex at all")).toBe(false)
        expect(secretMatches("the-secret", "abcd")).toBe(false)
    })
})

describe("whether a request will take it", () => {
    it("takes the right secret while it is alive", () => {
        expect(canVerify(live(), "the-secret").ok).toBe(true)
    })

    it("refuses a wrong secret with the same words as an unknown one", () => {
        // Telling the caller "right request, wrong secret" would confirm
        // that a request exists, which is half of what an attacker wants.
        const wrong = canVerify(live(), "not-it")
        const missing = canVerify(null, "not-it")
        expect(wrong.ok).toBe(false)
        expect(missing.ok).toBe(false)
        expect((wrong as any).reason).toBe((missing as any).reason)
    })

    it("refuses once the three minutes are up", () => {
        const past = new Date(Date.now() - 1000)
        const verdict = canVerify(live({ expires_at: past }), "the-secret")
        expect(verdict.ok).toBe(false)
        expect((verdict as any).reason).toContain("expired")
    })

    it("refuses a secret already spent", () => {
        const verdict = canVerify(live({ used_at: new Date() }), "the-secret")
        expect(verdict.ok).toBe(false)
        expect((verdict as any).reason).toContain("already been used")
    })

    it("refuses a request that was retired", () => {
        expect(canVerify(live({ status: "cancelled" }), "the-secret").ok).toBe(false)
        expect(canVerify(live({ status: "completed" }), "the-secret").ok).toBe(false)
    })

    it("refuses a request with no expiry at all rather than treating it as forever", () => {
        expect(canVerify(live({ expires_at: null }), "the-secret").ok).toBe(false)
    })
})

describe("the window", () => {
    it("is three minutes", () => {
        expect(WINDOW_SECONDS).toBe(180)
        const from = new Date("2026-09-05T10:00:00Z")
        expect(expiresAt(from).toISOString()).toBe("2026-09-05T10:03:00.000Z")
    })

    it("counts down and stops at zero", () => {
        const now = new Date("2026-09-05T10:00:00Z")
        expect(secondsLeft({ expires_at: new Date("2026-09-05T10:02:00Z") }, now)).toBe(120)
        expect(secondsLeft({ expires_at: new Date("2026-09-05T09:59:00Z") }, now)).toBe(0)
        expect(secondsLeft({ expires_at: null }, now)).toBe(0)
    })
})

describe("both hands on the switch", () => {
    it("is not ready with only our proof", () => {
        expect(isReady({ local_verified_at: new Date(), remote_confirmed_at: null })).toBe(false)
    })

    it("is not ready with only theirs", () => {
        expect(isReady({ local_verified_at: null, remote_confirmed_at: new Date() })).toBe(false)
    })

    it("is ready with both", () => {
        expect(isReady({ local_verified_at: new Date(), remote_confirmed_at: new Date() })).toBe(true)
    })

    it("is never ready again once it is done", () => {
        expect(
            isReady({
                local_verified_at: new Date(),
                remote_confirmed_at: new Date(),
                status: "completed",
            }),
        ).toBe(false)
    })
})

describe("what gets written down", () => {
    it("is not the secret", () => {
        expect(redacted()).toEqual({ redacted: true })
        expect(JSON.stringify(redacted())).not.toContain("secret_")
    })
})
