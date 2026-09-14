import { createReadStream, promises as fs } from "fs"
import path from "path"
import type { Readable } from "stream"

/**
 * Where a customer's invoice PDF is kept.
 *
 * Neither backend ever produces a public URL. Medusa's file module serves
 * everything it stores from a public origin, which is right for product
 * images and wrong for an invoice carrying a customer's name, address and
 * GSTIN — anyone holding the link could read it. Both backends here hand
 * the bytes to the store route, which checks the order belongs to the
 * customer asking before streaming them.
 */

export type StoredObject = {
    body: Readable
    contentType: string
    size: number | null
}

export interface InvoiceStorage {
    readonly kind: "local" | "s3"
    put(key: string, bytes: Buffer, contentType: string): Promise<void>
    get(key: string): Promise<StoredObject | null>
    remove(key: string): Promise<void>
}

export type StorageSettings = {
    invoice_storage?: string | null
    invoice_local_dir?: string | null
    s3_bucket?: string | null
    s3_region?: string | null
    s3_endpoint?: string | null
    s3_prefix?: string | null
    s3_force_path_style?: boolean | null
    s3_access_key_id?: string | null
    s3_secret_access_key?: string | null
}

/** Keys are built from ids we generate; this refuses anything else. */
export function safeKey(key: string): string {
    const clean = String(key ?? "").trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,300}$/.test(clean) || clean.includes("..")) {
        throw new Error(`invalid invoice storage key: ${JSON.stringify(key)}`)
    }
    return clean
}

export function invoiceKey(orderId: string, number: string): string {
    const part = (v: string) =>
        String(v)
            .replace(/[^A-Za-z0-9._-]+/g, "_")
            .replace(/\.{2,}/g, "_")
            .replace(/^[._-]+/, "")
    return safeKey(`invoices/${part(orderId)}/${part(number)}.pdf`)
}

export class LocalInvoiceStorage implements InvoiceStorage {
    readonly kind = "local" as const

    constructor(private readonly root: string) {}

    private resolve(key: string): string {
        const full = path.resolve(this.root, safeKey(key))
        if (!full.startsWith(path.resolve(this.root) + path.sep)) {
            throw new Error("invoice key escapes the storage directory")
        }
        return full
    }

    async put(key: string, bytes: Buffer): Promise<void> {
        const full = this.resolve(key)
        await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 })
        await fs.writeFile(full, bytes, { mode: 0o600 })
    }

    async get(key: string): Promise<StoredObject | null> {
        const full = this.resolve(key)
        try {
            const stat = await fs.stat(full)
            return { body: createReadStream(full), contentType: "application/pdf", size: stat.size }
        } catch (e: any) {
            if (e?.code === "ENOENT") return null
            throw e
        }
    }

    async remove(key: string): Promise<void> {
        await fs.rm(this.resolve(key), { force: true })
    }
}

export class S3InvoiceStorage implements InvoiceStorage {
    readonly kind = "s3" as const
    private client: any

    constructor(private readonly cfg: Required<Pick<StorageSettings, "s3_bucket">> & StorageSettings) {}

    private async s3() {
        if (!this.client) {
            const { S3Client } = await import("@aws-sdk/client-s3")
            this.client = new S3Client({
                region: this.cfg.s3_region || "auto",
                endpoint: this.cfg.s3_endpoint || undefined,
                forcePathStyle: Boolean(this.cfg.s3_force_path_style),
                credentials:
                    this.cfg.s3_access_key_id && this.cfg.s3_secret_access_key
                        ? {
                              accessKeyId: this.cfg.s3_access_key_id,
                              secretAccessKey: this.cfg.s3_secret_access_key,
                          }
                        : undefined,
            })
        }
        return this.client
    }

    private objectKey(key: string): string {
        const prefix = String(this.cfg.s3_prefix ?? "").replace(/^\/+|\/+$/g, "")
        return prefix ? `${prefix}/${safeKey(key)}` : safeKey(key)
    }

    async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
        const { PutObjectCommand } = await import("@aws-sdk/client-s3")
        const client = await this.s3()
        await client.send(
            new PutObjectCommand({
                Bucket: this.cfg.s3_bucket,
                Key: this.objectKey(key),
                Body: bytes,
                ContentType: contentType,
                // Private regardless of the bucket's default ACL setting.
                ACL: "private",
            }),
        )
    }

    async get(key: string): Promise<StoredObject | null> {
        const { GetObjectCommand } = await import("@aws-sdk/client-s3")
        const client = await this.s3()
        try {
            const out = await client.send(
                new GetObjectCommand({ Bucket: this.cfg.s3_bucket, Key: this.objectKey(key) }),
            )
            return {
                body: out.Body as Readable,
                contentType: out.ContentType || "application/pdf",
                size: typeof out.ContentLength === "number" ? out.ContentLength : null,
            }
        } catch (e: any) {
            if (e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404) return null
            throw e
        }
    }

    async remove(key: string): Promise<void> {
        const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
        const client = await this.s3()
        await client.send(new DeleteObjectCommand({ Bucket: this.cfg.s3_bucket, Key: this.objectKey(key) }))
    }
}

/** A problem that stops invoices being stored, or null when the settings work. */
export function storageProblem(cfg: StorageSettings): string | null {
    if ((cfg.invoice_storage || "local") === "s3") {
        if (!cfg.s3_bucket) return "S3 storage needs a bucket"
        if (!cfg.s3_access_key_id || !cfg.s3_secret_access_key) return "S3 storage needs an access key and secret"
        return null
    }
    return null
}

export function storageFor(cfg: StorageSettings): InvoiceStorage {
    const problem = storageProblem(cfg)
    if (problem) throw new Error(problem)
    if ((cfg.invoice_storage || "local") === "s3") {
        return new S3InvoiceStorage({ ...cfg, s3_bucket: cfg.s3_bucket as string })
    }
    // Deliberately outside `static/`, which Medusa serves to anyone.
    const root = cfg.invoice_local_dir || path.join(process.cwd(), "private", "erpnext-invoices")
    return new LocalInvoiceStorage(root)
}
