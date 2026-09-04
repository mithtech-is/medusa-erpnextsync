import crypto from "crypto"

/**
 * Starting over, with both hands on the switch.
 *
 * A hard reset throws away configuration somebody spent a week getting
 * right, so the interesting question is not what it does but who may ask.
 * The answer is: nobody, alone. Each side generates a secret and shows it
 * once; each side has to be handed the other's and prove it holds it.
 * Only a side holding both proofs resets.
 *
 * This module is the part with no database in it: making a secret,
 * hashing it, comparing it without leaking how far the comparison got,
 * and deciding whether a request is still alive. It is separate so those
 * four things can be tested exactly, which is the point of having them.
 *
 * `medusync/reset.py` is the mirror. The hash must agree — plain SHA-256
 * of the UTF-8 secret, hex — because each side stores its own secret's
 * hash and the other side sends the plaintext back.
 */

/** 32 bytes. Anything shorter is a password, and nobody types this often. */
export const SECRET_BYTES = 32

/**
 * Three minutes: long enough to carry a secret between two browser tabs,
 * short enough that one left on a screen is worthless by the time
 * somebody walks past it.
 */
export const WINDOW_SECONDS = 180

export const VERIFY_EVENT = "reset.verify"

export type ResetRequestLike = {
    secret_hash?: string | null
    expires_at?: Date | string | null
    used_at?: Date | string | null
    status?: string | null
}

export type Verdict =
    | { ok: true }
    | { ok: false; reason: string }

/** Url-safe, unpadded, so it survives being pasted into anything. */
export function newSecret(): string {
    return crypto.randomBytes(SECRET_BYTES).toString("base64url")
}

export function hashSecret(secret: string): string {
    return crypto.createHash("sha256").update(String(secret ?? ""), "utf8").digest("hex")
}

/**
 * Compare without revealing how much of the hash matched.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * signal, so both sides are hashed to a fixed width first.
 */
export function secretMatches(secret: string, storedHash: string | null | undefined): boolean {
    if (!secret || !storedHash) return false
    const offered = Buffer.from(hashSecret(secret), "hex")
    let stored: Buffer
    try {
        stored = Buffer.from(String(storedHash), "hex")
    } catch {
        return false
    }
    if (offered.length !== stored.length) return false
    return crypto.timingSafeEqual(offered, stored)
}

export function expiresAt(from: Date = new Date()): Date {
    return new Date(from.getTime() + WINDOW_SECONDS * 1000)
}

export function secondsLeft(request: ResetRequestLike, now: Date = new Date()): number {
    if (!request?.expires_at) return 0
    const end = new Date(request.expires_at).getTime()
    return Math.max(0, Math.floor((end - now.getTime()) / 1000))
}

/**
 * May this request accept the secret it was just offered?
 *
 * A wrong secret deliberately does not spend the request — a typo, or
 * anyone who can reach the endpoint, must not cost the operator the three
 * minutes and the trip. Spending it is the caller's job, after a yes.
 */
export function canVerify(
    request: ResetRequestLike | null | undefined,
    secret: string,
    now: Date = new Date(),
): Verdict {
    if (!request) return { ok: false, reason: "no live reset request matches that secret" }
    if (request.status && !["pending", "verified"].includes(String(request.status))) {
        return { ok: false, reason: `that request is ${request.status}` }
    }
    if (request.used_at) return { ok: false, reason: "that secret has already been used" }
    if (!request.expires_at || new Date(request.expires_at).getTime() <= now.getTime()) {
        return { ok: false, reason: "that secret has expired" }
    }
    if (!secretMatches(secret, request.secret_hash)) {
        return { ok: false, reason: "no live reset request matches that secret" }
    }
    return { ok: true }
}

/** Both proofs in hand? */
export function isReady(request: {
    local_verified_at?: Date | string | null
    remote_confirmed_at?: Date | string | null
    status?: string | null
}): boolean {
    if (!request) return false
    if (request.status && ["completed", "cancelled", "expired", "failed"].includes(String(request.status))) {
        return false
    }
    return Boolean(request.local_verified_at && request.remote_confirmed_at)
}

/**
 * Strip anything that must not be written down.
 *
 * Used before the inbound audit row for a `reset.verify` is written. The
 * row still has to exist — an attempt on the reset endpoint is exactly
 * what somebody would want to see afterwards — it just must not carry the
 * thing being attempted.
 */
export function redacted(): Record<string, any> {
    return { redacted: true }
}
