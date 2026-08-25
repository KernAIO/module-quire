-- Additive: nullable column and defaults, so the image before this one still reads the table.
ALTER TABLE "mod_quire"."pages" ADD COLUMN IF NOT EXISTS "database_id" uuid;--> statement-breakpoint
ALTER TABLE "mod_quire"."pages" ADD COLUMN IF NOT EXISTS "props" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mod_quire"."pages" ADD COLUMN IF NOT EXISTS "computed" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_ws_database_idx" ON "mod_quire"."pages" USING btree ("workspace_id","database_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pages_props_idx" ON "mod_quire"."pages" USING gin ("props");