import { Migration } from "@mikro-orm/migrations"

/**
 * Invoices a customer can download, and the choices ERPNext sends about
 * them: what an order becomes, who numbers the invoice, and where the
 * private copy is kept.
 */
export class Migration20260913120000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            CREATE TABLE IF NOT EXISTS "erpnext_invoice" (
                "id" text NOT NULL,
                "order_id" text NOT NULL,
                "customer_id" text NULL,
                "number" text NOT NULL,
                "source" text NOT NULL DEFAULT 'erpnext',
                "invoice_date" text NULL,
                "total" double precision NULL,
                "currency" text NULL,
                "status" text NULL,
                "storage" text NULL,
                "object_key" text NULL,
                "content_type" text NULL,
                "size_bytes" integer NULL,
                "fetched_at" timestamptz NULL,
                "fetch_error" text NULL,
                "created_at" timestamptz NOT NULL DEFAULT now(),
                "updated_at" timestamptz NOT NULL DEFAULT now(),
                "deleted_at" timestamptz NULL,
                CONSTRAINT "erpnext_invoice_pkey" PRIMARY KEY ("id")
            );
        `)
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_invoice_order_id" ON "erpnext_invoice" ("order_id") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_erpnext_invoice_number" ON "erpnext_invoice" ("number") WHERE deleted_at IS NULL;`,
        )
        // One store-issued invoice per order. Two allocators racing each take
        // a different number, so the index above cannot catch them; this one
        // decides which of them issued the invoice.
        this.addSql(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_erpnext_invoice_store_order" ON "erpnext_invoice" ("order_id") WHERE source = 'store' AND deleted_at IS NULL;`,
        )
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "order_document" text NULL,
                ADD COLUMN IF NOT EXISTS "invoice_numbering" text NOT NULL DEFAULT 'erpnext',
                ADD COLUMN IF NOT EXISTS "store_invoice_prefix" text NULL,
                ADD COLUMN IF NOT EXISTS "store_invoice_next" integer NOT NULL DEFAULT 1,
                ADD COLUMN IF NOT EXISTS "send_invoice_to_store" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "record_payments" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "invoice_storage" text NOT NULL DEFAULT 'local',
                ADD COLUMN IF NOT EXISTS "invoice_local_dir" text NULL,
                ADD COLUMN IF NOT EXISTS "s3_bucket" text NULL,
                ADD COLUMN IF NOT EXISTS "s3_region" text NULL,
                ADD COLUMN IF NOT EXISTS "s3_endpoint" text NULL,
                ADD COLUMN IF NOT EXISTS "s3_prefix" text NULL,
                ADD COLUMN IF NOT EXISTS "s3_force_path_style" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "s3_access_key_id" text NULL,
                ADD COLUMN IF NOT EXISTS "s3_secret_access_key" text NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`DROP TABLE IF EXISTS "erpnext_invoice";`)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "order_document",
                DROP COLUMN IF EXISTS "invoice_numbering",
                DROP COLUMN IF EXISTS "store_invoice_prefix",
                DROP COLUMN IF EXISTS "store_invoice_next",
                DROP COLUMN IF EXISTS "send_invoice_to_store",
                DROP COLUMN IF EXISTS "record_payments",
                DROP COLUMN IF EXISTS "invoice_storage",
                DROP COLUMN IF EXISTS "invoice_local_dir",
                DROP COLUMN IF EXISTS "s3_bucket",
                DROP COLUMN IF EXISTS "s3_region",
                DROP COLUMN IF EXISTS "s3_endpoint",
                DROP COLUMN IF EXISTS "s3_prefix",
                DROP COLUMN IF EXISTS "s3_force_path_style",
                DROP COLUMN IF EXISTS "s3_access_key_id",
                DROP COLUMN IF EXISTS "s3_secret_access_key";
        `)
    }
}
