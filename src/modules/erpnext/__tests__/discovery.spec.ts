import { describe, expect, it } from "vitest"
import {
    humanizePath,
    describeModel,
    describeRecord,
    mergeFieldSources,
    type DiscoveredField,
    type OrmEntityMeta,
} from "../discovery"

/**
 * The customer module's metadata as mikro-orm really reports it, dumped
 * from a running Medusa 2.19 and trimmed. The shapes matter: a relation is
 * identified by `kind` (mikro-orm 6 renamed it from `reference`) and its
 * `type` holds the *target class name*, not a column type — so a fixture
 * that invents `reference` makes every relation look like a string column.
 * That is exactly the bug the live check caught, so this stays verbatim.
 */
const CUSTOMER_MODULE: Record<string, OrmEntityMeta> = {
    Customer: {
        className: "Customer",
        properties: {
            id: { name: "id", kind: "scalar", type: "string", primary: true, nullable: false },
            email: { name: "email", kind: "scalar", type: "string", nullable: true },
            first_name: { name: "first_name", kind: "scalar", type: "string", nullable: true },
            has_account: { name: "has_account", kind: "scalar", type: "boolean", nullable: false },
            metadata: { name: "metadata", kind: "scalar", type: "JsonType", nullable: true },
            created_at: { name: "created_at", kind: "scalar", type: "date", nullable: false },
            addresses: {
                name: "addresses",
                kind: "1:m",
                entity: "CustomerAddress",
                type: "CustomerAddress",
                targetMeta: { className: "CustomerAddress" },
            },
            groups: {
                name: "groups",
                kind: "m:n",
                entity: "CustomerGroup",
                type: "CustomerGroup",
                targetMeta: { className: "CustomerGroup" },
            },
            default_address: {
                name: "default_address",
                kind: "m:1",
                entity: "CustomerAddress",
                type: "CustomerAddress",
                targetMeta: { className: "CustomerAddress" },
            },
            // The key half of the pair above. Medusa's DML emits both, and
            // only `mapToPk` distinguishes them — see the Product module,
            // which has `collection` and `collection_id` exactly like this.
            default_address_id: {
                name: "default_address_id",
                kind: "m:1",
                entity: "CustomerAddress",
                type: "CustomerAddress",
                mapToPk: true,
                nullable: true,
                targetMeta: { className: "CustomerAddress" },
            },
        },
    },
    CustomerAddress: {
        className: "CustomerAddress",
        properties: {
            id: { name: "id", kind: "scalar", type: "string", primary: true },
            city: { name: "city", kind: "scalar", type: "string", nullable: true },
            customer: {
                name: "customer",
                kind: "m:1",
                entity: "Customer",
                type: "Customer",
                nullable: false,
                targetMeta: { className: "Customer" },
            },
        },
    },
    CustomerGroup: {
        className: "CustomerGroup",
        properties: {
            id: { name: "id", kind: "scalar", type: "string", primary: true },
            name: { name: "name", kind: "scalar", type: "string", nullable: true },
        },
    },
}

const pathsOf = (fields: Array<{ path: string }>) => fields.map((f) => f.path)

describe("describeModel", () => {
    it("emits every scalar column of the root model", () => {
        const paths = pathsOf(describeModel(CUSTOMER_MODULE, "Customer"))
        expect(paths).toEqual(
            expect.arrayContaining([
                "id",
                "email",
                "first_name",
                "has_account",
                "metadata",
                "created_at",
            ]),
        )
    })

    it("types the primary key as an id and maps orm types to picker types", () => {
        const byPath = Object.fromEntries(
            describeModel(CUSTOMER_MODULE, "Customer").map((f) => [f.path, f.type]),
        )
        expect(byPath.id).toBe("id")
        expect(byPath.email).toBe("string")
        expect(byPath.has_account).toBe("boolean")
        expect(byPath.metadata).toBe("json")
        expect(byPath.created_at).toBe("datetime")
    })

    it("descends into a to-one relation so nested paths are offered", () => {
        // `sales_channel.name` had to be added to the curated list by hand in
        // Phase 3 precisely because nothing derived it. This is that fix.
        const paths = pathsOf(describeModel(CUSTOMER_MODULE, "Customer"))
        expect(paths).toContain("default_address.city")
    })

    it("offers a to-many relation as one array field and does not descend", () => {
        const fields = describeModel(CUSTOMER_MODULE, "Customer")
        const addresses = fields.find((f) => f.path === "addresses")
        expect(addresses?.type).toBe("array")
        // A dotted path cannot address a row inside a collection, so
        // offering `addresses.city` would produce a mapping that never
        // resolves. Child rows are a handler's job, not the flat mapper's.
        expect(pathsOf(fields).some((p) => p.startsWith("addresses."))).toBe(false)
    })

    it("never types a relation as a plain string", () => {
        // A relation's `type` is its target class name, so reading `type`
        // without first checking `kind` silently produced `string` for every
        // relation — and the picker offered `groups` as a text field.
        const fields = describeModel(CUSTOMER_MODULE, "Customer")
        for (const name of ["addresses", "groups"]) {
            const f = fields.find((x) => x.path === name)
            expect(f, `${name} should be discovered`).toBeDefined()
            expect(f!.type, `${name} should not be a string`).toBe("array")
            expect(f!.relation).toBe(true)
        }
    })

    it("offers a foreign key as an id and does not descend into it", () => {
        // `collection_id` holds a string, so `collection_id.handle` would
        // resolve against a string and never produce a value — while
        // `collection.handle` is the path that works.
        const fields = describeModel(CUSTOMER_MODULE, "Customer")
        const fk = fields.find((f) => f.path === "default_address_id")
        expect(fk?.type).toBe("id")
        expect(pathsOf(fields).some((p) => p.startsWith("default_address_id."))).toBe(false)
        expect(pathsOf(fields)).toContain("default_address.city")
    })

    it("stops at the depth limit rather than following relations forever", () => {
        const paths = pathsOf(describeModel(CUSTOMER_MODULE, "Customer", { maxDepth: 0 }))
        expect(paths).toContain("email")
        expect(paths.some((p) => p.includes("."))).toBe(false)
    })

    it("does not loop on a relation that points back at its parent", () => {
        // Customer → default_address → customer → … would never terminate.
        const paths = pathsOf(
            describeModel(CUSTOMER_MODULE, "Customer", { maxDepth: 5 }),
        )
        expect(paths).not.toContain("default_address.customer.email")
    })

    it("returns nothing for a model the module does not have", () => {
        expect(describeModel(CUSTOMER_MODULE, "Nonexistent")).toEqual([])
    })

    it("labels a derived field from its path", () => {
        const first = describeModel(CUSTOMER_MODULE, "Customer").find(
            (f) => f.path === "first_name",
        )
        expect(first?.label).toBe("First name")
        expect(first?.source).toBe("model")
    })
})

describe("describeRecord", () => {
    it("walks a real record when the model definition is unavailable", () => {
        const fields = describeRecord({
            id: "cus_1",
            email: "a@b.com",
            has_account: true,
            metadata: { tier: "gold" },
            created_at: new Date(),
            sales_channel: { id: "sc_1", name: "Default" },
            addresses: [{ city: "Pune" }],
        })
        const byPath = Object.fromEntries(fields.map((f) => [f.path, f.type]))
        expect(byPath.email).toBe("string")
        expect(byPath.has_account).toBe("boolean")
        expect(byPath.created_at).toBe("datetime")
        expect(byPath["sales_channel.name"]).toBe("string")
        expect(byPath.addresses).toBe("array")
        expect(fields.every((f) => f.source === "record")).toBe(true)
    })

    it("offers a json object as a whole field as well as descending it", () => {
        // `metadata` is mappable in one piece (transform: json) and its keys
        // are mappable individually. Both are legitimate targets.
        const paths = pathsOf(describeRecord({ metadata: { tier: "gold" } }))
        expect(paths).toContain("metadata")
        expect(paths).toContain("metadata.tier")
    })

    it("ignores nulls rather than guessing a type from them", () => {
        const fields = describeRecord({ id: "cus_1", phone: null })
        expect(pathsOf(fields)).toContain("phone")
        expect(fields.find((f) => f.path === "phone")?.type).toBe("string")
    })

    it("returns nothing for a record that is not an object", () => {
        expect(describeRecord(null as any)).toEqual([])
    })
})

describe("mergeFieldSources", () => {
    const derived = describeModel(CUSTOMER_MODULE, "Customer")

    it("keeps the curated label and transform over the derived guess", () => {
        const merged = mergeFieldSources(derived, [
            {
                path: "email",
                label: "Customer email",
                type: "string",
                suggested_transform: "lowercase",
            },
        ])
        const email = merged.find((f) => f.path === "email")
        expect(email?.label).toBe("Customer email")
        expect(email?.suggested_transform).toBe("lowercase")
        expect(email?.source).toBe("curated")
    })

    it("still offers derived fields nobody curated", () => {
        const merged = mergeFieldSources(derived, [
            { path: "email", label: "Customer email", type: "string" },
        ])
        const paths = pathsOf(merged)
        expect(paths).toContain("has_account")
        expect(merged.find((f) => f.path === "has_account")?.source).toBe("model")
    })

    it("keeps a curated path the model does not expose", () => {
        // Enriched paths come from the fetch adapter's `relations`, not from
        // the root model's own columns — dropping them would remove working
        // mappings from the picker.
        const merged = mergeFieldSources(derived, [
            { path: "sales_channel.name", label: "Sales channel", type: "string" },
        ])
        const sc = merged.find((f) => f.path === "sales_channel.name")
        expect(sc?.source).toBe("curated")
    })

    it("lists curated fields in their curated order, before the discoveries", () => {
        const merged = mergeFieldSources(derived, [
            { path: "email", label: "Customer email", type: "string" },
            { path: "id", label: "Medusa id", type: "id" },
        ])
        expect(pathsOf(merged).slice(0, 2)).toEqual(["email", "id"])
    })

    it("does not emit the same path twice", () => {
        const merged = mergeFieldSources(derived, [
            { path: "email", label: "Customer email", type: "string" },
        ])
        const paths = pathsOf(merged)
        expect(new Set(paths).size).toBe(paths.length)
    })
})

/**
 * "Required" here has to mean *an operator must map this*, not "the column
 * is NOT NULL". Nullability alone flags `id`, `created_at`, `status` and
 * every column of a related model — none of which anybody maps — while the
 * two fields Medusa genuinely refuses a product without are `title` and
 * `handle`. The shapes below are the real ones from a running 2.19.
 */
describe("required fields", () => {
    const PRODUCT: Record<string, OrmEntityMeta> = {
        Product: {
            className: "Product",
            properties: {
                id: { name: "id", kind: "scalar", type: "string", primary: true, nullable: false },
                title: { name: "title", kind: "scalar", type: "string", nullable: false },
                handle: { name: "handle", kind: "scalar", type: "string", nullable: false },
                subtitle: { name: "subtitle", kind: "scalar", type: "string", nullable: true },
                status: {
                    name: "status", kind: "scalar", type: "string",
                    nullable: false, default: "draft",
                },
                discountable: {
                    name: "discountable", kind: "scalar", type: "boolean",
                    nullable: false, default: true,
                },
                created_at: {
                    name: "created_at", kind: "scalar", type: "date",
                    nullable: false, defaultRaw: "now()", onCreate: true,
                },
                collection: {
                    name: "collection", kind: "m:1", entity: "ProductCollection",
                    type: "ProductCollection", nullable: true,
                    targetMeta: { className: "ProductCollection" },
                },
            },
        },
        ProductCollection: {
            className: "ProductCollection",
            properties: {
                id: { name: "id", kind: "scalar", type: "string", primary: true, nullable: false },
                title: { name: "title", kind: "scalar", type: "string", nullable: false },
            },
        },
    }

    const requiredPaths = (fields: DiscoveredField[]) =>
        fields.filter((f) => f.required).map((f) => f.path)

    it("is exactly the fields a record cannot be created without", () => {
        expect(requiredPaths(describeModel(PRODUCT, "Product")).sort()).toEqual([
            "handle",
            "title",
        ])
    })

    it("does not call a generated primary key required", () => {
        expect(requiredPaths(describeModel(PRODUCT, "Product"))).not.toContain("id")
    })

    it("does not call a column with a default required", () => {
        // The store fills `status` and `discountable` itself, so demanding a
        // mapping for them would send an operator looking for a source that
        // does not exist.
        const req = requiredPaths(describeModel(PRODUCT, "Product"))
        expect(req).not.toContain("status")
        expect(req).not.toContain("discountable")
    })

    it("does not call a timestamp the store writes required", () => {
        expect(requiredPaths(describeModel(PRODUCT, "Product"))).not.toContain("created_at")
    })

    it("never calls a nested field required", () => {
        // `collection.title` is mandatory on ProductCollection, not on the
        // product being mapped. Flagging it demands a value for a record
        // this mapping does not create.
        const paths = requiredPaths(describeModel(PRODUCT, "Product"))
        expect(paths.some((p) => p.includes("."))).toBe(false)
    })

    it("keeps a curated entry's required flag through the merge", () => {
        const merged = mergeFieldSources(describeModel(PRODUCT, "Product"), [
            { path: "title", label: "Product title", type: "string" },
        ])
        expect(merged.find((f) => f.path === "title")?.required).toBe(true)
    })
})

describe("the picker's view of the merged list", () => {
    const f = (path: string, type: any, extra: Partial<DiscoveredField> = {}): DiscoveredField => ({
        path,
        label: humanizePath(path),
        type,
        source: "model",
        ...(path.includes(".") ? { relation: true } : {}),
        ...extra,
    })
    const derived = [
        f("id", "id"),
        f("total", "number"),
        f("email", "string", { required: true }),
        f("created_at", "datetime"),
        f("updated_at", "datetime"),
        f("metadata", "json"),
        f("raw_total", "json"),
        f("billing_address_id", "id"),
        f("billing_address.id", "id"),
        f("billing_address.city", "string"),
        f("billing_address.customer_id", "id"),
        f("billing_address.created_at", "datetime"),
        f("billing_address.metadata", "json"),
        f("sales_channel.name", "string"),
    ]
    const curated = [
        { path: "total", label: "Total (minor units)", type: "number" as const },
        { path: "billing_address_id", label: "Billing address id", type: "id" as const },
        { path: "created_at", label: "Created at", type: "datetime" as const },
    ]
    const list = mergeFieldSources(derived, curated)
    const byPath = Object.fromEntries(list.map((x) => [x.path, x]))

    it("groups a nested path under its record and leaves the record's own fields ungrouped", () => {
        expect(byPath["billing_address.city"].group).toBe("Billing address")
        expect(byPath["sales_channel.name"].group).toBe("Sales channel")
        expect(byPath["total"].group).toBe("")
    })

    it("hides bookkeeping columns unless asked", () => {
        for (const p of ["updated_at", "metadata", "raw_total", "billing_address.created_at", "billing_address.metadata"]) {
            expect(byPath[p].advanced, p).toBe(true)
        }
    })

    it("keeps a curated bookkeeping column in plain view", () => {
        expect(byPath["created_at"].advanced).toBeFalsy()
    })

    it("offers a related record's id once, as the column this record carries", () => {
        expect(byPath["billing_address_id"].advanced).toBeFalsy()
        expect(byPath["billing_address.id"].advanced).toBe(true)
    })

    it("hides a related record's own foreign keys", () => {
        expect(byPath["billing_address.customer_id"].advanced).toBe(true)
    })

    it("never hides a required field or a plain value", () => {
        expect(byPath["email"].advanced).toBeFalsy()
        expect(byPath["billing_address.city"].advanced).toBeFalsy()
        expect(byPath["id"].advanced).toBeFalsy()
    })
})
