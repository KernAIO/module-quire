CREATE TABLE IF NOT EXISTS "mod_quire"."databases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"inline" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_quire"."properties" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_quire"."relations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"property_id" uuid NOT NULL,
	"from_page_id" uuid NOT NULL,
	"to_page_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_quire"."views" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"database_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'table' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "databases_ws_page_idx" ON "mod_quire"."databases" USING btree ("workspace_id","page_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "properties_db_key_uq" ON "mod_quire"."properties" USING btree ("workspace_id","database_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "properties_ws_db_idx" ON "mod_quire"."properties" USING btree ("workspace_id","database_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relations_uq" ON "mod_quire"."relations" USING btree ("workspace_id","property_id","from_page_id","to_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relations_ws_from_idx" ON "mod_quire"."relations" USING btree ("workspace_id","from_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "relations_ws_to_idx" ON "mod_quire"."relations" USING btree ("workspace_id","to_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "views_ws_db_idx" ON "mod_quire"."views" USING btree ("workspace_id","database_id","position");--> statement-breakpoint

-- Row-level security, the same triple every tenant table gets.
ALTER TABLE "mod_quire"."databases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."databases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "databases_ws_isolation" ON "mod_quire"."databases";--> statement-breakpoint
CREATE POLICY "databases_ws_isolation" ON "mod_quire"."databases"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

ALTER TABLE "mod_quire"."properties" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."properties" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "properties_ws_isolation" ON "mod_quire"."properties";--> statement-breakpoint
CREATE POLICY "properties_ws_isolation" ON "mod_quire"."properties"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

ALTER TABLE "mod_quire"."views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."views" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "views_ws_isolation" ON "mod_quire"."views";--> statement-breakpoint
CREATE POLICY "views_ws_isolation" ON "mod_quire"."views"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

ALTER TABLE "mod_quire"."relations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."relations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "relations_ws_isolation" ON "mod_quire"."relations";--> statement-breakpoint
CREATE POLICY "relations_ws_isolation" ON "mod_quire"."relations"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
