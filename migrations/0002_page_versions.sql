CREATE TABLE IF NOT EXISTS "mod_quire"."page_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"kind" text DEFAULT 'auto' NOT NULL,
	"label" text,
	"state" "bytea" NOT NULL,
	"snapshot" "bytea",
	"text" text DEFAULT '' NOT NULL,
	"size" integer DEFAULT 0 NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_ws_page_idx" ON "mod_quire"."page_versions" USING btree ("workspace_id","page_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_versions_ws_created_idx" ON "mod_quire"."page_versions" USING btree ("workspace_id","created_at");--> statement-breakpoint

-- Row-level security, the same triple every tenant table gets. `force` matters because the table
-- owner would otherwise bypass the policy, and the owner is the role the service connects as.
ALTER TABLE "mod_quire"."page_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."page_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "page_versions_ws_isolation" ON "mod_quire"."page_versions";--> statement-breakpoint
CREATE POLICY "page_versions_ws_isolation" ON "mod_quire"."page_versions"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
