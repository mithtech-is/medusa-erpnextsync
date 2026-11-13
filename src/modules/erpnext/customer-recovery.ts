/**
 * Which Medusa customers ERPNext has lost.
 *
 * A customer is lost when ERPNext has no Customer with its email and no
 * Customer under the name its link points at. A customer whose link still
 * resolves is present even if ERPNext holds no email for it: `email_id`
 * is read off a Contact, so a customer without one reads blank.
 *
 * Whether a lost customer is pushed again is not decided here. The
 * Customer mapping's trigger and the selection field decide that when the
 * push runs, the same as for a live event.
 */

export type CustomerForRecovery = { id: string; email?: string | null }

export type CustomerLink = { medusa_id: string; erpnext_name: string }

export function customersMissingOnFrappe<T extends CustomerForRecovery>(args: {
    customers: T[]
    frappeEmails: Set<string>
    frappeNames: Set<string>
    links: CustomerLink[]
}): { eligible: T[]; missing: T[] } {
    const linkOf = new Map(args.links.map((l) => [l.medusa_id, l.erpnext_name]))
    const eligible = args.customers.filter((c) => Boolean(String(c?.email ?? "").trim()))
    const missing = eligible.filter((c) => {
        if (args.frappeEmails.has(String(c.email).trim().toLowerCase())) return false
        const name = linkOf.get(c.id)
        return !(name && args.frappeNames.has(name))
    })
    return { eligible, missing }
}
