import { describe, expect, it } from "vitest"
import { titleFromText } from "../registry"

/**
 * ERPNext descriptions are spec text, not product names. They arrive with
 * the rich-text editor's markup around them, or hard-wrapped at a fixed
 * column so a phrase breaks across two lines. Neither renders.
 */
describe("the title an ERP description becomes", () => {
    it("unwraps the rich-text editor's markup", () => {
        expect(titleFromText("<div><p>TRAY - 100X50 1.4MM GI PERF. (WITHCOVER)</p></div>")).toBe(
            "TRAY - 100X50 1.4MM GI PERF. (WITHCOVER)",
        )
    })

    it("joins a phrase the ERP hard-wrapped across lines", () => {
        expect(titleFromText("12K HOUR KIT FOR AIR\nCOMPRESSOR (SERVICE)")).toBe(
            "12K HOUR KIT FOR AIR COMPRESSOR (SERVICE)",
        )
        expect(titleFromText("SET,PISTON RING")).toBe("SET,PISTON RING")
    })

    it("turns a line break element into a space rather than gluing words", () => {
        expect(titleFromText("FUEL<br>FILTER")).toBe("FUEL FILTER")
        expect(titleFromText("FUEL<br/>FILTER")).toBe("FUEL FILTER")
    })

    it("leaves the casing alone, because the abbreviations are the name", () => {
        // Title-casing would give "Gi", "Kva", "Ms" — not what a buyer searches.
        expect(titleFromText("100X50 1.4MM GI TRAY")).toBe("100X50 1.4MM GI TRAY")
        expect(titleFromText("500KVA MAINTENANCE KIT")).toBe("500KVA MAINTENANCE KIT")
    })

    it("decodes the entities the editor leaves behind", () => {
        expect(titleFromText("VALVE &amp; SEAT &quot;A&quot;")).toBe('VALVE & SEAT "A"')
        expect(titleFromText("ROTOR&nbsp;BRUSH")).toBe("ROTOR BRUSH")
    })

    it("collapses runs of whitespace and trims the ends", () => {
        expect(titleFromText("  ELEMENT,AIR   CLEANER \n ")).toBe("ELEMENT,AIR CLEANER")
    })

    it("survives nothing at all", () => {
        expect(titleFromText("")).toBe("")
        expect(titleFromText(undefined as any)).toBe("")
    })
})
