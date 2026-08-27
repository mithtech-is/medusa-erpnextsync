import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260825124249 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "wallet_settlement" drop constraint if exists "wallet_settlement_settlement_batch_id_unique";`);
    this.addSql(`create table if not exists "wallet_settlement" ("id" text not null, "settlement_batch_id" text not null, "period_from" text null, "period_to" text null, "total_credits" integer null, "total_debits" integer null, "net_amount" integer null, "currency" text null, "status" text check ("status" in ('Pending', 'Posted', 'Failed', 'Cancelled')) not null default 'Pending', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "wallet_settlement_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_wallet_settlement_settlement_batch_id_unique" ON "wallet_settlement" ("settlement_batch_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_wallet_settlement_deleted_at" ON "wallet_settlement" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "wallet_settlement" cascade;`);
  }

}
