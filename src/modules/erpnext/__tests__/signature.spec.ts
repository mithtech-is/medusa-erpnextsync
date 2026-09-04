import { describe, expect, it } from "vitest"

import { isUntouchedDefault, mayEnable, signatureOf } from "../signature"

const mapping = (over: Record<string, any> = {}) => ({
    medusa_entity: "customer",
    doctype: "Customer",
    direction: "both",
    key_medusa_field: "email",
    key_erpnext_field: "email_id",
    events: ["customer.created", "customer.updated"],
    trigger_preset: "always",
    trigger_condition: null,
    skip_unchanged: false,
    allow_create: true,
    allow_update: true,
    field_mappings: [
        { medusa_path: "email", erpnext_field: "email_id", direction: "both" },
        { medusa_path: "first_name", erpnext_field: "customer_name", direction: "push" },
    ],
    ...over,
})

describe("what the fingerprint covers", () => {
    it("is stable for the same mapping", () => {
        expect(signatureOf(mapping())).toBe(signatureOf(mapping()))
    })

    it("ignores the order of the field grid", () => {
        // Dragging a row up is not a change of behaviour, and costing
        // somebody a re-rehearsal for it would train them to distrust the
        // gate.
        const reversed = mapping({ field_mappings: [...mapping().field_mappings].reverse() })
        expect(signatureOf(reversed)).toBe(signatureOf(mapping()))
    })

    it("ignores the order of the event list", () => {
        const shuffled = mapping({ events: ["customer.updated", "customer.created"] })
        expect(signatureOf(shuffled)).toBe(signatureOf(mapping()))
    })

    it("ignores the name and description entirely", () => {
        // They are documentation. They change nothing about what happens.
        const renamed: any = { ...mapping(), name: "Renamed", description: "new words" }
        expect(signatureOf(renamed)).toBe(signatureOf(mapping()))
    })

    it("changes when a field is added", () => {
        const extra = mapping({
            field_mappings: [
                ...mapping().field_mappings,
                { medusa_path: "phone", erpnext_field: "mobile_no", direction: "push" },
            ],
        })
        expect(signatureOf(extra)).not.toBe(signatureOf(mapping()))
    })

    it("changes when a field's direction changes", () => {
        const flipped = mapping({
            field_mappings: [
                { medusa_path: "email", erpnext_field: "email_id", direction: "push" },
                { medusa_path: "first_name", erpnext_field: "customer_name", direction: "push" },
            ],
        })
        expect(signatureOf(flipped)).not.toBe(signatureOf(mapping()))
    })

    it("changes when the key, the doctype, the entity or the direction changes", () => {
        for (const patch of [
            { key_erpnext_field: "name" },
            { doctype: "Supplier" },
            { medusa_entity: "product" },
            { direction: "push" },
        ]) {
            expect(signatureOf(mapping(patch))).not.toBe(signatureOf(mapping()))
        }
    })

    it("changes when the trigger changes", () => {
        expect(signatureOf(mapping({ trigger_condition: "amount > 10" }))).not.toBe(
            signatureOf(mapping()),
        )
    })

    it("treats a blank condition and no condition as the same thing", () => {
        expect(signatureOf(mapping({ trigger_condition: "   " }))).toBe(signatureOf(mapping()))
    })

    it("copes with an empty mapping rather than throwing", () => {
        expect(typeof signatureOf(null)).toBe("string")
        expect(typeof signatureOf({})).toBe("string")
    })
})

describe("the enable gate", () => {
    it("refuses a mapping nobody has rehearsed", () => {
        const verdict = mayEnable(mapping({ enabled: false }), mapping({ enabled: true }))
        expect(verdict.ok).toBe(false)
    })

    it("allows one whose rehearsal still describes it", () => {
        const current = { ...mapping({ enabled: false }), tested_signature: signatureOf(mapping()) }
        expect(mayEnable(current, mapping({ enabled: true })).ok).toBe(true)
    })

    it("refuses one that was edited since it was rehearsed", () => {
        const current = { ...mapping({ enabled: false }), tested_signature: signatureOf(mapping()) }
        const edited = mapping({
            enabled: true,
            field_mappings: [
                ...mapping().field_mappings,
                { medusa_path: "phone", erpnext_field: "mobile_no", direction: "push" },
            ],
        })
        expect(mayEnable(current, edited).ok).toBe(false)
    })

    it("never gets in the way of switching one off", () => {
        expect(mayEnable(mapping({ enabled: true }), mapping({ enabled: false })).ok).toBe(true)
    })

    it("leaves a mapping that is already running alone", () => {
        // Retro-fitting the rule would stop a working store on the next
        // save of anything, which is not a safety improvement.
        const running = mapping({ enabled: true })
        const editedWhileRunning = mapping({ enabled: true, key_erpnext_field: "name" })
        expect(mayEnable(running, editedWhileRunning).ok).toBe(true)
    })

    it("treats a brand-new mapping as unrehearsed", () => {
        expect(mayEnable(null, mapping({ enabled: true })).ok).toBe(false)
    })
})

describe("telling an untouched default from an edited one", () => {
    it("recognises one nobody has changed", () => {
        const row = { shipped_signature: signatureOf(mapping()) }
        expect(isUntouchedDefault(row, mapping())).toBe(true)
    })

    it("recognises one somebody has", () => {
        const row = { shipped_signature: signatureOf(mapping()) }
        expect(isUntouchedDefault(row, mapping({ key_erpnext_field: "name" }))).toBe(false)
    })

    it("says no when it has no idea", () => {
        // No fingerprint means we cannot tell, and "cannot tell" must not
        // read as "safe to overwrite".
        expect(isUntouchedDefault({}, mapping())).toBe(false)
        expect(isUntouchedDefault({ shipped_signature: null }, mapping())).toBe(false)
    })
})
