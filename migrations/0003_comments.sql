CREATE TABLE IF NOT EXISTS "mod_quire"."comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"parent_id" uuid,
	"thread_id" uuid NOT NULL,
	"author_id" uuid,
	"body" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_text" text DEFAULT '' NOT NULL,
	"mention_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"anchor" jsonb,
	"quoted_text" text DEFAULT '' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_ws_page_idx" ON "mod_quire"."comments" USING btree ("workspace_id","page_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_ws_thread_idx" ON "mod_quire"."comments" USING btree ("workspace_id","thread_id","created_at");--> statement-breakpoint

-- Row-level security, the same triple every tenant table gets.
ALTER TABLE "mod_quire"."comments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."comments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "comments_ws_isolation" ON "mod_quire"."comments";--> statement-breakpoint
CREATE POLICY "comments_ws_isolation" ON "mod_quire"."comments"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
