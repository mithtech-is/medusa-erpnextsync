/**
 * The smallest Frappe REST client that the setup code needs, with `fetch`
 * injectable so the whole "create or update the Custom Field and the
 * Webhooks" sequence can be exercised against a fake ERPNext in a unit
 * test. The service's own calls elsewhere keep using `fetch` directly.
 */

export type FrappeResult =
    | { ok: true; status: number; data: any }
    | { ok: false; status: number; error: string; body?: any }

export type FrappeClient = {
    get(path: string, query?: Record<string, string>): Promise<FrappeResult>
    post(path: string, body: any): Promise<FrappeResult>
    put(path: string, body: any): Promise<FrappeResult>
    delete(path: string): Promise<FrappeResult>
}

/** What ERPNext meant, out of the several places it puts an error. */
export function frappeErrorMessage(status: number, body: any, text?: string): string {
    const messages: string[] = []
    const raw = body?._server_messages
    if (typeof raw === "string") {
        try {
            for (const entry of JSON.parse(raw)) {
                try {
                    const m = JSON.parse(entry)
                    if (m?.message) messages.push(String(m.message).replace(/<[^>]+>/g, ""))
                } catch {
                    messages.push(String(entry))
                }
            }
        } catch {
            /* not the shape we expected; fall through */
        }
    }
    if (messages.length) return `HTTP ${status}: ${messages.join("; ").slice(0, 300)}`
    if (typeof body?.exception === "string") return `HTTP ${status}: ${body.exception.slice(0, 300)}`
    if (typeof body?.message === "string") return `HTTP ${status}: ${body.message.slice(0, 300)}`
    return `HTTP ${status}: ${String(text ?? "").slice(0, 300)}`
}

export function makeFrappeClient(opts: {
    baseUrl: string
    token: string
    timeoutMs?: number
    fetchImpl?: typeof fetch
}): FrappeClient {
    const base = String(opts.baseUrl ?? "").replace(/\/+$/, "")
    const doFetch = opts.fetchImpl ?? fetch
    const timeout = opts.timeoutMs ?? 15000

    async function call(method: string, path: string, query?: Record<string, string>, body?: any): Promise<FrappeResult> {
        const qs = query ? `?${new URLSearchParams(query)}` : ""
        const headers: Record<string, string> = {
            Authorization: `token ${opts.token}`,
            Accept: "application/json",
        }
        if (body !== undefined) headers["Content-Type"] = "application/json"
        let res: Response
        try {
            res = await doFetch(`${base}${path}${qs}`, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(timeout),
            })
        } catch (err: any) {
            return { ok: false, status: 0, error: err?.message ?? String(err) }
        }
        const text = await res.text().catch(() => "")
        let json: any = null
        try {
            json = text ? JSON.parse(text) : null
        } catch {
            json = null
        }
        if (!res.ok) return { ok: false, status: res.status, error: frappeErrorMessage(res.status, json, text), body: json }
        return { ok: true, status: res.status, data: json?.data ?? json?.message ?? json }
    }

    return {
        get: (path, query) => call("GET", path, query),
        post: (path, body) => call("POST", path, undefined, body),
        put: (path, body) => call("PUT", path, undefined, body),
        delete: (path) => call("DELETE", path),
    }
}
