import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260723174408 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "booking_form" ("id" text not null, "cart_id" text not null, "group_id" text not null, "type" text check ("type" in ('tour', 'package')) not null default 'tour', "entity_id" text not null, "entity_date" timestamptz not null, "pre_data" jsonb null, "status" text check ("status" in ('draft', 'consumed')) not null default 'draft', "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "booking_form_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_booking_form_deleted_at" ON "booking_form" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_booking_form_cart_id" ON "booking_form" ("cart_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_booking_form_group_id" ON "booking_form" ("group_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "booking_form" cascade;`);
  }

}
