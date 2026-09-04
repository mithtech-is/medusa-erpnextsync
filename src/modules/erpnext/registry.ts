/**
 * Registry of Medusa-side entities the mapping UI can target.
 *
 * Each entry describes:
 *   - which Medusa module owns the entity (built-in or custom)
 *   - which event names fire on its lifecycle (used as the default
 *     `events` array suggestion in the admin form)
 *   - the dot-paths the operator can pick from in the left column of
 *     the field-mapper (with types + descriptions, so the UI can
 *     render a sensible picker)
 *   - how to fetch a fully-enriched record by id (used by the push
 *     subscriber + the pull cron's upsert path)
 *   - how to upsert a record by an arbitrary key (used by the pull
 *     cron when applying changes from Frappe back into Medusa)
 *   - whether the underlying module is actually installed on this
 *     Medusa deployment — controls whether the entity shows up in
 *     the admin picker
 *
 * Built-in modules (CUSTOMER, ORDER, PRODUCT, CART, REGION, …) are
 * always available — Medusa wires them into every project. Custom
 * modules only appear if registered in medusa-config.ts. The
 * availability check is a try/catch around
 * `container.resolve(moduleName)` — no separate registration list to
 * keep in sync.
 *
 * Extending the registry: new entry per entity, ideally via the
 * `genericEntity()` builder so the boilerplate stays tiny. The
 * builder derives the standard `fetchById` / `upsertByKey` /
 * `availableInContainer` adapters from a module name + model name.
 */

import { Modules } from "@medusajs/framework/utils"

export type MedusaFieldType =
    | "string"
    | "number"
    | "boolean"
    | "json"
    | "datetime"
    | "array"
    | "id"

export type MedusaFieldDescriptor = {
    /** Dot-notation path relative to the enriched entity object. */
    path: string
    label: string
    type: MedusaFieldType
    description?: string
    /** Default suggested transform — gives the UI a sensible starting
     *  point ("emails should probably be lowercased on push"). */
    suggested_transform?: string
}

export type EntityFetcher = (
    container: any,
    id: string,
) => Promise<Record<string, any> | null>

export type EntityUpserter = (
    container: any,
    key_field: string,
    key_value: string,
    payload: Record<string, any>,
) => Promise<{ ok: boolean; id?: string; created?: boolean; error?: string }>

/** Safe soft-delete for inbound `.deleted` / `.canceled` events. Never
 *  hard-deletes: disables, unpublishes, or cancels so nothing is lost and
 *  the action is reversible. Entities that omit it skip inbound deletes. */
export type EntityDisabler = (
    container: any,
    key_field: string,
    key_value: string,
) => Promise<{ ok: boolean; action?: string; id?: string; error?: string; skipped?: boolean }>

export type EntityDescriptor = {
    key: string
    label: string
    /** Source module name. Built-in modules use the `Modules.X`
     *  constant string (e.g. "customer"); custom modules use their
     *  literal name as registered in medusa-config.ts (e.g.
     *  "cashfree_wallet"). The `availableInContainer` adapter uses
     *  this to confirm the module is registered. */
    moduleName: string
    /** Whether this is a custom module that may or may not be
     *  installed (vs. a Medusa core module that's always there).
     *  Drives the availability check + a UI badge ("custom module"). */
    isCustomModule: boolean
    /** Suggested Medusa event names this entity fires. The admin UI
     *  pre-fills the events checkbox group; the operator can still
     *  pick any subset / add custom names. */
    events: string[]
    /** Curated list of dot-paths surfaced in the field-mapper. */
    paths: MedusaFieldDescriptor[]
    /** Default identity field used on push — matches the Frappe-side
     *  `name` lookup. Operator can override per-mapping. */
    default_key_path: string
    fetchById: EntityFetcher
    upsertByKey: EntityUpserter
    /** Optional safe soft-delete used for inbound `.deleted` /
     *  `.canceled` events. Omitted → inbound deletes are skipped. */
    disableByKey?: EntityDisabler
    /** Optional availability check. When omitted, defaults to a
     *  try/resolve on `moduleName`. Override for entities whose
     *  parent module exposes them via a sub-feature flag. */
    availableInContainer?: (container: any) => boolean
}

// ─── Generic builder ─────────────────────────────────────────────────

type GenericEntityArgs = {
    key: string
    label: string
    moduleName: string
    isCustomModule?: boolean
    /** Model name singular (e.g. "Customer", "Wallet"). The adapter
     *  derives the list/update method names from this — "Customer"
     *  → `listCustomers` + `updateCustomers`. Override `methodSuffix`
     *  if your service breaks the plural convention. */
    modelName: string
    /** Method-name suffix used to compose `list<X>` / `update<X>`.
     *  Defaults to `<modelName>s`. Override for irregular plurals
     *  (e.g. CustomerGroup → CustomerGroups). */
    methodSuffix?: string
    /** Default `relations` to load when fetching by id. Empty array
     *  by default. */
    fetchRelations?: string[]
    events: string[]
    default_key_path: string
    paths: MedusaFieldDescriptor[]
    /** Override the default upsertByKey — for entities that need
     *  custom upsert semantics (e.g. wallets that must go through
     *  the service's credit/debit helpers, or immutable ledgers). */
    upsertByKey?: EntityUpserter
    /** Optional safe soft-delete for inbound `.deleted` / `.canceled`. */
    disableByKey?: EntityDisabler
}

function genericEntity(args: GenericEntityArgs): EntityDescriptor {
    const suffix = args.methodSuffix ?? `${args.modelName}s`
    const listFn = `list${suffix}`
    const updateFn = `update${suffix}`
    const createFn = `create${suffix}`
    return {
        key: args.key,
        label: args.label,
        moduleName: args.moduleName,
        isCustomModule: args.isCustomModule ?? false,
        events: args.events,
        paths: args.paths,
        default_key_path: args.default_key_path,
        disableByKey: args.disableByKey,
        async fetchById(container, id) {
            const m: any = container.resolve(args.moduleName)
            // withDeleted so `.deleted` events (which fire after the row is
            // soft-deleted) still enrich to the full record — the mapping key
            // (email/handle) is needed to tell Frappe which doc to disable.
            const opts: any = { take: 1, withDeleted: true }
            if (args.fetchRelations?.length) opts.relations = args.fetchRelations
            const rows = await m[listFn]({ id }, opts)
            return rows?.[0] ?? null
        },
        async upsertByKey(container, key_field, key_value, payload) {
            if (args.upsertByKey) {
                return args.upsertByKey(container, key_field, key_value, payload)
            }
            const m: any = container.resolve(args.moduleName)
            const filter: any = {}
            filter[key_field] = key_value
            const [existing] = await m[listFn](filter, { take: 1 })
            if (existing) {
                const [updated] = await m[updateFn]([
                    { id: existing.id, ...payload },
                ])
                return { ok: true, id: updated.id, created: false }
            }
            if (typeof m[createFn] === "function") {
                const created = await m[createFn]([payload])
                const row = Array.isArray(created) ? created[0] : created
                return { ok: true, id: row?.id, created: true }
            }
            return {
                ok: false,
                error: `module '${args.moduleName}' has no ${createFn} helper`,
            }
        },
    }
}

// ─── Built-in Medusa entities (always available) ─────────────────────

const customerEntity = genericEntity({
    key: "customer",
    label: "Customer",
    moduleName: Modules.CUSTOMER,
    modelName: "Customer",
    events: [
        "customer.created",
        "customer.updated",
        "customer.deleted",
    ],
    default_key_path: "email",
    fetchRelations: ["addresses"],
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "email", label: "Email", type: "string", suggested_transform: "lowercase" },
        { path: "first_name", label: "First name", type: "string" },
        { path: "last_name", label: "Last name", type: "string" },
        { path: "phone", label: "Phone", type: "string", suggested_transform: "trim" },
        { path: "company_name", label: "Company", type: "string" },
        { path: "has_account", label: "Has account", type: "boolean" },
        { path: "addresses.0.address_1", label: "Primary address line 1", type: "string" },
        { path: "addresses.0.address_2", label: "Primary address line 2", type: "string" },
        { path: "addresses.0.city", label: "Primary city", type: "string" },
        { path: "addresses.0.province", label: "Primary state / province", type: "string" },
        { path: "addresses.0.postal_code", label: "Primary postal code", type: "string" },
        { path: "addresses.0.country_code", label: "Primary country (ISO)", type: "string", suggested_transform: "uppercase" },
        { path: "metadata", label: "Whole metadata blob", type: "json", suggested_transform: "json" },
        { path: "created_at", label: "Created at", type: "datetime", suggested_transform: "date_iso" },
        { path: "updated_at", label: "Updated at", type: "datetime", suggested_transform: "date_iso" },
    ],
    upsertByKey: async (container, _kf, _kv, payload) => {
        const m: any = container.resolve(Modules.CUSTOMER)
        const email = payload.email
        if (!email) return { ok: false, error: "customer upsert needs `email` on the payload" }
        const existingList = (await m.listCustomers({ email }, { take: 1 })) || []
        const existing = existingList[0]
        if (existing) {
            // Selector/data form on purpose: the array-with-id form
            // `updateCustomers([{id, ...}])` trips a mikro-orm exception-
            // converter bug on some Medusa builds (masks the real error as
            // "reading '0'"); the selector form is unaffected.
            await m.updateCustomers({ id: existing.id }, payload)
            return { ok: true, id: existing.id, created: false }
        }
        const created = await m.createCustomers([payload])
        const c = Array.isArray(created) ? created[0] : created
        return { ok: true, id: c?.id, created: true }
    },
    // Safe inbound delete: mark the customer disabled in metadata rather
    // than destroying the record (reversible). key_value is the mapped
    // key (email by default).
    disableByKey: async (container, _kf, key_value) => {
        const m: any = container.resolve(Modules.CUSTOMER)
        const existingList = (await m.listCustomers({ email: key_value }, { take: 1 })) || []
        const existing = existingList[0]
        if (!existing) return { ok: true, skipped: true, action: "absent" }
        // Selector/data form (see upsertByKey note).
        await m.updateCustomers(
            { id: existing.id },
            { metadata: { ...(existing.metadata || {}), erpnext_disabled: true } },
        )
        return { ok: true, id: existing.id, action: "disabled" }
    },
})

// Enrich the customer record with its B2B company's GSTIN before it is pushed.
// The base fetchById returns the customer + addresses; the linked company (and
// therefore the GSTIN) is not part of the Medusa customer model, so we resolve
// it here — the only place on the push path with a container. The link is read
// from `metadata.company_id` (the mirror the storefront writes; present for
// every company-linked customer on this build) with a fallback to a raw
// `company_id` column if a future model exposes it. Fully guarded: no company
// module, no link, or a failed lookup just ships the customer without a GSTIN.
{
    const baseCustomerFetch = customerEntity.fetchById
    customerEntity.fetchById = async (container: any, id: string) => {
        const rec: any = await baseCustomerFetch(container, id)
        if (!rec) return rec
        try {
            const companyId = rec.company_id ?? rec.metadata?.company_id
            if (companyId) {
                const companySvc: any = container.resolve("company")
                const list = (await companySvc?.listCompanies?.({ id: companyId }, { take: 1 })) || []
                const co = list[0]
                if (co) {
                    rec.gstin = co.gstin ?? null
                    rec.company_trade_name = co.trade_name ?? null
                    // The company's GST-registered billing address (a JSON blob
                    // {line1,line2,city,state,postal_code,country_code}) — carried
                    // through so the augment step can emit it as an Address too.
                    rec.company_billing_address = co.billing_address ?? null
                    rec.company_id_resolved = companyId
                }
            }
        } catch {
            // No company module (generic deployment) or lookup failed — the
            // customer still syncs, just without GSTIN/company data.
        }
        return rec
    }
}

const customerGroupEntity = genericEntity({
    key: "customer_group",
    label: "Customer group",
    moduleName: Modules.CUSTOMER,
    modelName: "CustomerGroup",
    events: ["customer_group.created", "customer_group.updated", "customer_group.deleted"],
    default_key_path: "name",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "name", label: "Name", type: "string" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
        { path: "created_at", label: "Created at", type: "datetime", suggested_transform: "date_iso" },
    ],
})

const orderEntity: EntityDescriptor = {
    key: "order",
    label: "Order",
    moduleName: Modules.ORDER,
    isCustomModule: false,
    events: ["order.placed", "order.payment_captured", "order.fulfillment_created", "order.canceled"],
    default_key_path: "display_id",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "display_id", label: "Display id (#42)", type: "number" },
        { path: "email", label: "Customer email", type: "string", suggested_transform: "lowercase" },
        { path: "currency_code", label: "Currency", type: "string", suggested_transform: "uppercase" },
        { path: "total", label: "Total (minor units)", type: "number" },
        { path: "subtotal", label: "Subtotal (minor units)", type: "number" },
        { path: "tax_total", label: "Tax total (minor units)", type: "number" },
        { path: "discount_total", label: "Discount total (minor units)", type: "number" },
        { path: "payment_status", label: "Payment status", type: "string" },
        { path: "fulfillment_status", label: "Fulfillment status", type: "string" },
        { path: "customer.id", label: "Customer id", type: "id" },
        { path: "shipping_address.address_1", label: "Shipping address line 1", type: "string" },
        { path: "shipping_address.city", label: "Shipping city", type: "string" },
        { path: "shipping_address.country_code", label: "Shipping country (ISO)", type: "string", suggested_transform: "uppercase" },
        { path: "items", label: "Line items (array)", type: "array", suggested_transform: "json" },
        { path: "created_at", label: "Created at", type: "datetime", suggested_transform: "date_iso" },
        // Which channel the order arrived through. ERPNext keeps this on
        // Sales Order so the storefront can say "placed online" or "placed
        // by our sales team" instead of guessing from the order alone.
        { path: "source", label: "Order source (sales channel)", type: "string" },
        { path: "sales_channel_id", label: "Sales channel id", type: "id" },
    ],
    async fetchById(container, id) {
        // Use query.graph (RemoteQuery), NOT orderModule.listOrders with deep
        // relations: the order module's list throws ('kind'/'targetMeta') or
        // returns degraded rows for cross-module relations
        // (items.variant.product, addresses, payment_collections). query.graph
        // resolves the module links properly.
        // Computed ORDER-level totals (total/tax_total) via query.graph throw
        // "Shipping method version is required to load adjustments" on orders
        // with shipping methods. So take the grand total from `summary`
        // (stored, no computation) and line-level totals from the items — both
        // fetch cleanly. The augment derives tax/shipping/discount from these.
        const query: any = container.resolve("query")
        const { data } = await query.graph({
            entity: "order",
            fields: [
                "id",
                "display_id",
                "email",
                "customer_id",
                "currency_code",
                "payment_status",
                "fulfillment_status",
                "summary.*",
                "items.title",
                // In Medusa v2 the order line QUANTITY lives on the item
                // DETAIL (order_item), not the line item — `items.quantity`
                // resolves to null. Fetch `items.detail.quantity` and flatten
                // it below so the augment reads the real qty (a null qty was
                // silently defaulting to 1 and corrupting Sales Order lines).
                "items.detail.quantity",
                "items.quantity",
                "items.unit_price",
                "items.total",
                "items.tax_total",
                "items.variant.sku",
                "items.variant.product.handle",
                "items.variant.product.title",
                "shipping_address.*",
                "billing_address.*",
                "payment_collections.id",
                "payment_collections.status",
                "sales_channel_id",
                "sales_channel.name",
            ],
            filters: { id },
        })
        const order: any = data?.[0]
        if (!order) return null
        // Flatten the real line quantity (from the item detail) onto each item
        // so downstream (augmentSalesDocPayload) reads the correct qty. Without
        // this, `items.quantity` is null and the SO line silently became qty 1.
        for (const it of order.items || []) {
            const q = it?.detail?.quantity
            if (q != null) it.quantity = q
        }
        // Flatten the stored grand total onto the record for the augment.
        order.total =
            order.summary?.current_order_total ??
            order.summary?.original_order_total ??
            0
        // Flatten the channel to a name a mapping can carry straight into
        // Sales Order.medusa_order_source. A store with no channels at all
        // still came from the web, which is truer than an empty string.
        order.source = order.sales_channel?.name || "web"
        return order
    },
    async upsertByKey() {
        return { ok: false, error: "order upsert from ERPNext not supported (Sales Invoices are generated FROM Medusa orders)" }
    },
}

const productEntity: EntityDescriptor = {
    key: "product",
    label: "Product",
    moduleName: Modules.PRODUCT,
    isCustomModule: false,
    events: ["product.created", "product.updated", "product.deleted"],
    default_key_path: "metadata.isin",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "title", label: "Title", type: "string" },
        { path: "handle", label: "Handle (URL slug)", type: "string" },
        { path: "subtitle", label: "Subtitle", type: "string" },
        { path: "description", label: "Description", type: "string" },
        { path: "status", label: "Status (draft/published)", type: "string" },
        { path: "thumbnail", label: "Thumbnail URL", type: "string" },
        { path: "metadata.isin", label: "ISIN (metadata)", type: "string", suggested_transform: "uppercase" },
        { path: "metadata.search_aliases", label: "Search aliases (metadata, csv)", type: "string" },
        { path: "metadata.sector", label: "Sector (metadata)", type: "string" },
        { path: "metadata.industry", label: "Industry (metadata)", type: "string" },
        { path: "metadata.face_value", label: "Face value (metadata)", type: "string" },
        { path: "metadata", label: "Whole metadata blob", type: "json", suggested_transform: "json" },
        { path: "variants.0.sku", label: "First variant SKU", type: "string" },
        { path: "created_at", label: "Created at", type: "datetime", suggested_transform: "date_iso" },
        { path: "updated_at", label: "Updated at", type: "datetime", suggested_transform: "date_iso" },
    ],
    async fetchById(container, id) {
        const m: any = container.resolve(Modules.PRODUCT)
        const [row] = await m.listProducts({ id }, { take: 1, relations: ["variants"], withDeleted: true })
        return row ?? null
    },
    async upsertByKey(container, key_field, key_value, payload) {
        const m: any = container.resolve(Modules.PRODUCT)
        const isMetaKey = key_field.startsWith("metadata.")
        const metaKeyName = isMetaKey ? key_field.slice("metadata.".length) : null
        const filter: any = {}
        if (isMetaKey) {
            filter.metadata = { [metaKeyName as string]: key_value }
        } else {
            filter[key_field] = key_value
        }
        // When deduping on a metadata path, GUARANTEE the persisted row
        // carries the key. A pull whose field_mappings don't project the
        // key into its payload (e.g. metadata.isin is push-only on the
        // Product ↔ Security mapping) would otherwise create a fresh row
        // every run — the dedup filter never matches what was written.
        const keyMeta = isMetaKey ? { [metaKeyName as string]: key_value } : {}
        const existing = await m.listProducts(filter, { select: ["id", "metadata"], take: 1 })
        if (existing?.length) {
            const mergedMeta = { ...(existing[0].metadata || {}), ...(payload.metadata || {}), ...keyMeta }
            const patch: any = { id: existing[0].id, ...payload, metadata: mergedMeta }
            // Never rename an existing product's handle when the dedup
            // key is something else (e.g. metadata.isin): a canonical
            // product lives under a human slug and a pull that also maps
            // handle←isin would otherwise clobber its storefront URL.
            if (key_field !== "handle") delete patch.handle
            // Catalog products (keyed by handle) must stay sellable — keep them
            // published and ensure a variant whose sku == handle exists (a
            // product synced before this fix, or a pull that dropped variants,
            // would otherwise be a variant-less draft that can't be sold or
            // stock-matched).
            if (key_field === "handle") {
                if (patch.status === undefined) patch.status = "published"
                const [full] = await m.listProducts(
                    { id: existing[0].id },
                    { take: 1, relations: ["variants"] },
                )
                const hasSku = (full?.variants || []).some(
                    (v: any) => v.sku === String(key_value),
                )
                if (!hasSku) {
                    patch.options = [{ title: "Default", values: ["Default"] }]
                    patch.variants = [
                        {
                            title: "Default",
                            sku: String(key_value),
                            manage_inventory: true,
                            options: { Default: "Default" },
                        },
                    ]
                }
            }
            const [updated] = await m.upsertProducts([patch])
            return { ok: true, id: updated.id, created: false }
        }
        const createPayload: any = isMetaKey
            ? { ...payload, metadata: { ...(payload.metadata || {}), ...keyMeta } }
            : { ...payload }
        // Catalog products (keyed by handle): create a real sellable simple
        // product — one "Default" option + one variant (sku == handle ==
        // ERPNext item_code) + published. Without this an ERPNext item lands
        // as a variant-less draft and inventory (keyed by sku) can't match.
        if (!isMetaKey && key_field === "handle") {
            if (createPayload.status === undefined) createPayload.status = "published"
            createPayload.options = createPayload.options ?? [
                { title: "Default", values: ["Default"] },
            ]
            createPayload.variants = createPayload.variants ?? [
                {
                    title: "Default",
                    sku: String(key_value),
                    manage_inventory: true,
                    options: { Default: "Default" },
                },
            ]
        }
        const [created] = await m.upsertProducts([createPayload])
        return { ok: true, id: created.id, created: true }
    },
    // Safe inbound delete: unpublish (status → draft) rather than destroy.
    async disableByKey(container, key_field, key_value) {
        const m: any = container.resolve(Modules.PRODUCT)
        const isMetaKey = key_field.startsWith("metadata.")
        const filter: any = isMetaKey
            ? { metadata: { [key_field.slice("metadata.".length)]: key_value } }
            : { [key_field]: key_value }
        const [existing] = await m.listProducts(filter, { select: ["id"], take: 1 })
        if (!existing) return { ok: true, skipped: true, action: "absent" }
        await m.upsertProducts([{ id: existing.id, status: "draft" }])
        return { ok: true, id: existing.id, action: "unpublished" }
    },
}

const productCategoryEntity = genericEntity({
    key: "product_category",
    label: "Product category",
    moduleName: Modules.PRODUCT,
    modelName: "ProductCategory",
    methodSuffix: "ProductCategories",
    events: ["product-category.created", "product-category.updated", "product-category.deleted"],
    default_key_path: "handle",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "name", label: "Name", type: "string" },
        { path: "handle", label: "Handle", type: "string" },
        { path: "description", label: "Description", type: "string" },
        { path: "is_active", label: "Active", type: "boolean" },
        { path: "is_internal", label: "Internal-only", type: "boolean" },
        { path: "parent_category_id", label: "Parent category id", type: "id" },
    ],
})

const productCollectionEntity = genericEntity({
    key: "product_collection",
    label: "Product collection",
    moduleName: Modules.PRODUCT,
    modelName: "ProductCollection",
    events: ["product-collection.created", "product-collection.updated"],
    default_key_path: "handle",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "title", label: "Title", type: "string" },
        { path: "handle", label: "Handle", type: "string" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
    ],
})

const userEntity = genericEntity({
    key: "user",
    label: "User (Medusa admin)",
    moduleName: Modules.USER,
    modelName: "User",
    events: ["user.created", "user.updated", "user.deleted"],
    default_key_path: "email",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "email", label: "Email", type: "string", suggested_transform: "lowercase" },
        { path: "first_name", label: "First name", type: "string" },
        { path: "last_name", label: "Last name", type: "string" },
        { path: "created_at", label: "Created at", type: "datetime", suggested_transform: "date_iso" },
    ],
    upsertByKey: async () => ({ ok: false, error: "admin user pull from ERPNext not supported in v1" }),
})

const cartEntity = genericEntity({
    key: "cart",
    label: "Cart",
    moduleName: Modules.CART,
    modelName: "Cart",
    events: ["cart.created", "cart.updated"],
    default_key_path: "id",
    fetchRelations: ["items", "shipping_address", "billing_address"],
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "email", label: "Email", type: "string", suggested_transform: "lowercase" },
        { path: "currency_code", label: "Currency", type: "string", suggested_transform: "uppercase" },
        { path: "region_id", label: "Region id", type: "id" },
        { path: "customer_id", label: "Customer id", type: "id" },
        { path: "sales_channel_id", label: "Sales channel id", type: "id" },
        { path: "items", label: "Line items", type: "array", suggested_transform: "json" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
        { path: "completed_at", label: "Completed at", type: "datetime", suggested_transform: "date_iso" },
        { path: "created_at", label: "Created at", type: "datetime", suggested_transform: "date_iso" },
    ],
    upsertByKey: async () => ({ ok: false, error: "cart upsert from ERPNext not supported (carts are storefront-owned)" }),
})

const regionEntity = genericEntity({
    key: "region",
    label: "Region",
    moduleName: Modules.REGION,
    modelName: "Region",
    events: ["region.created", "region.updated", "region.deleted"],
    default_key_path: "name",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "name", label: "Name", type: "string" },
        { path: "currency_code", label: "Currency", type: "string", suggested_transform: "uppercase" },
        { path: "automatic_taxes", label: "Automatic taxes", type: "boolean" },
        { path: "countries", label: "Countries", type: "array", suggested_transform: "json" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
    ],
})

const salesChannelEntity = genericEntity({
    key: "sales_channel",
    label: "Sales channel",
    moduleName: Modules.SALES_CHANNEL,
    modelName: "SalesChannel",
    events: ["sales-channel.created", "sales-channel.updated"],
    default_key_path: "name",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "name", label: "Name", type: "string" },
        { path: "description", label: "Description", type: "string" },
        { path: "is_disabled", label: "Disabled", type: "boolean" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
    ],
})

const promotionEntity = genericEntity({
    key: "promotion",
    label: "Promotion",
    moduleName: Modules.PROMOTION,
    modelName: "Promotion",
    events: ["promotion.created", "promotion.updated", "promotion.deleted"],
    default_key_path: "code",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "code", label: "Code", type: "string", suggested_transform: "uppercase" },
        { path: "is_automatic", label: "Automatic", type: "boolean" },
        { path: "type", label: "Type (standard / buyget)", type: "string" },
        { path: "campaign_id", label: "Campaign id", type: "id" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
    ],
})

const stockLocationEntity = genericEntity({
    key: "stock_location",
    label: "Stock location",
    moduleName: Modules.STOCK_LOCATION,
    modelName: "StockLocation",
    events: ["stock-location.created", "stock-location.updated"],
    default_key_path: "name",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "name", label: "Name", type: "string" },
        { path: "address.address_1", label: "Address line 1", type: "string" },
        { path: "address.city", label: "City", type: "string" },
        { path: "address.country_code", label: "Country (ISO)", type: "string", suggested_transform: "uppercase" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
    ],
})

const inventoryItemEntity = genericEntity({
    key: "inventory_item",
    label: "Inventory item",
    moduleName: Modules.INVENTORY,
    modelName: "InventoryItem",
    events: ["inventory-item.created", "inventory-item.updated"],
    default_key_path: "sku",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "sku", label: "SKU", type: "string" },
        { path: "title", label: "Title", type: "string" },
        { path: "description", label: "Description", type: "string" },
        { path: "weight", label: "Weight", type: "number" },
        { path: "hs_code", label: "HS code", type: "string" },
        { path: "origin_country", label: "Origin country (ISO)", type: "string", suggested_transform: "uppercase" },
        { path: "material", label: "Material", type: "string" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
    ],
})

const currencyEntity = genericEntity({
    key: "currency",
    label: "Currency",
    moduleName: Modules.CURRENCY,
    modelName: "Currency",
    events: ["currency.created", "currency.updated"],
    default_key_path: "code",
    paths: [
        { path: "code", label: "Code (ISO 4217)", type: "string", suggested_transform: "uppercase" },
        { path: "symbol", label: "Symbol", type: "string" },
        { path: "symbol_native", label: "Symbol (native)", type: "string" },
        { path: "name", label: "Name", type: "string" },
    ],
    upsertByKey: async () => ({ ok: false, error: "currencies are Medusa-seeded; ERPNext-driven inserts not supported" }),
})

const apiKeyEntity = genericEntity({
    key: "api_key",
    label: "API key",
    moduleName: Modules.API_KEY,
    modelName: "ApiKey",
    events: ["api-key.created", "api-key.updated", "api-key.deleted"],
    default_key_path: "title",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "title", label: "Title", type: "string" },
        { path: "type", label: "Type (publishable / secret)", type: "string" },
        { path: "redacted", label: "Redacted preview", type: "string" },
    ],
    upsertByKey: async () => ({ ok: false, error: "API keys must be created in Medusa admin, not synced from ERPNext" }),
})

const paymentCollectionEntity = genericEntity({
    key: "payment_collection",
    label: "Payment collection",
    moduleName: Modules.PAYMENT,
    modelName: "PaymentCollection",
    events: ["payment-collection.created", "payment-collection.updated"],
    default_key_path: "id",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "amount", label: "Amount (minor units)", type: "number" },
        { path: "currency_code", label: "Currency", type: "string", suggested_transform: "uppercase" },
        { path: "status", label: "Status", type: "string" },
    ],
    upsertByKey: async () => ({ ok: false, error: "payment collections are storefront-owned; ERPNext-driven inserts not supported" }),
})

const fulfillmentEntity = genericEntity({
    key: "fulfillment",
    label: "Fulfillment",
    moduleName: Modules.FULFILLMENT,
    modelName: "Fulfillment",
    events: ["fulfillment.created", "fulfillment.shipment_created", "fulfillment.canceled"],
    default_key_path: "id",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "location_id", label: "Stock location id", type: "id" },
        { path: "shipped_at", label: "Shipped at", type: "datetime", suggested_transform: "date_iso" },
        { path: "delivered_at", label: "Delivered at", type: "datetime", suggested_transform: "date_iso" },
        { path: "canceled_at", label: "Canceled at", type: "datetime", suggested_transform: "date_iso" },
        { path: "metadata", label: "Metadata", type: "json", suggested_transform: "json" },
    ],
})

const walletSettlementEntity = genericEntity({
    key: "wallet_settlement",
    label: "Wallet settlement",
    moduleName: "wallet_settlement",
    modelName: "WalletSettlement",
    events: [
        "wallet_settlement.created",
        "wallet_settlement.updated",
        "wallet_settlement.deleted",
    ],
    default_key_path: "settlement_batch_id",
    paths: [
        { path: "id", label: "Medusa id", type: "id" },
        { path: "settlement_batch_id", label: "Batch id", type: "string" },
        { path: "period_from", label: "Period from", type: "string" },
        { path: "period_to", label: "Period to", type: "string" },
        { path: "total_credits", label: "Total credits", type: "number" },
        { path: "total_debits", label: "Total debits", type: "number" },
        { path: "net_amount", label: "Net amount", type: "number" },
        { path: "currency", label: "Currency", type: "string" },
        { path: "status", label: "Status", type: "string" },
    ],
    // Safe delete: mark Cancelled by key, never destroy. Uses the selector
    // form updateWalletSettlements({settlement_batch_id}, {...}) — NOT the
    // array-with-id form, which trips the mikro-orm bug (see customer
    // disableByKey).
    disableByKey: async (container, key_field, key_value) => {
        const m: any = container.resolve("wallet_settlement")
        const filter: any = {}
        filter[key_field] = key_value
        const [existing] = (await m.listWalletSettlements(filter, { take: 1 })) || []
        if (!existing) return { ok: true, skipped: true, action: "absent" }
        // Selector/data form (see customer upsert note) — updating by id
        // avoids the mikro-orm array-with-id exception-converter bug.
        await m.updateWalletSettlements({ id: existing.id }, { status: "Cancelled" })
        return { ok: true, id: existing.id, action: "cancelled" }
    },
})

// ─── Registry ─────────────────────────────────────────────────────────

const REGISTRY: Record<string, EntityDescriptor> = {
    // Built-in Medusa modules (always available)
    customer: customerEntity,
    customer_group: customerGroupEntity,
    order: orderEntity,
    product: productEntity,
    product_category: productCategoryEntity,
    product_collection: productCollectionEntity,
    user: userEntity,
    cart: cartEntity,
    region: regionEntity,
    sales_channel: salesChannelEntity,
    promotion: promotionEntity,
    stock_location: stockLocationEntity,
    inventory_item: inventoryItemEntity,
    currency: currencyEntity,
    api_key: apiKeyEntity,
    payment_collection: paymentCollectionEntity,
    fulfillment: fulfillmentEntity,
    // wallet_settlement was removed in the Phase 0 generic cleanup and
    // finally taken out of the picker here. The module it named was a
    // sandbox demo that no longer exists on either side: the Medusa module
    // folder is gone and the ERPNext doctype went with the risitex_erp
    // uninstall. Offering it in the entity picker meant an operator could
    // build a mapping that could only ever fail. The wallet contract this
    // connector actually wants is in pending_work.
}

/**
 * Resolve whether one entity is actually usable in this Medusa
 * process. For built-in modules the check is trivial (core modules
 * are always wired). For custom modules we try `container.resolve()`
 * — if the module isn't registered in medusa-config.ts the resolve
 * throws and the entity is hidden from the picker.
 */
export function isEntityAvailable(
    entity: EntityDescriptor,
    container: any,
): boolean {
    if (entity.availableInContainer) {
        try {
            return entity.availableInContainer(container)
        } catch {
            return false
        }
    }
    if (!entity.isCustomModule) {
        // Built-in modules — Medusa wires them universally.
        return true
    }
    try {
        const resolved = container.resolve(entity.moduleName)
        return Boolean(resolved)
    } catch {
        return false
    }
}

export function listMedusaEntities(container?: any): EntityDescriptor[] {
    const all = Object.values(REGISTRY)
    if (!container) return all
    return all.filter((e) => isEntityAvailable(e, container))
}

export function getMedusaEntity(key: string): EntityDescriptor | null {
    return REGISTRY[key] ?? null
}
