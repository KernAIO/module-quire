-- Labels, favourites, recent views and watchers: the ways a page is reached that are not the tree.
--
-- Generated from `src/server/schema.ts`, then edited in two ways drizzle-kit cannot do for itself.
--
-- Every statement is guarded. `create table`, `create index` and `create policy` throw on a replay,
-- and a module migration that throws takes down the whole host service rather than its own module —
-- core hosts five. Drizzle keys applied migrations by content hash, so regenerating the journal
-- replays every file against a schema that already has its objects. The composite primary keys are
-- inline in `create table` rather than a following `alter table … add primary key`, so they inherit
-- that guard instead of needing one of their own.
--
-- `favorites.position` is `COLLATE "C"`. It is a fractional index over a base-62 alphabet ordered by
-- code point, so `ORDER BY position` is only the order the algorithm intended under byte comparison.
-- This database is `en_US.UTF-8`, where `'U' < 'c'` is false — somebody's sidebar would come back
-- shuffled, and nothing would fail. drizzle-kit does not carry collation in its snapshot, which is
-- how `properties.position` and `views.position` lost theirs; if this file is ever regenerated, put
-- it back.
CREATE TABLE IF NOT EXISTS "mod_quire"."favorites" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"position" text COLLATE "C" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "favorites_user_id_page_id_pk" PRIMARY KEY("user_id","page_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_quire"."labels" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"name" text NOT NULL,
	"colour" text DEFAULT 'grey' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_quire"."page_labels" (
	"page_id" uuid NOT NULL,
	"label_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_labels_page_id_label_id_pk" PRIMARY KEY("page_id","label_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_quire"."recent_views" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recent_views_user_id_page_id_pk" PRIMARY KEY("user_id","page_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mod_quire"."watchers" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchers_user_id_page_id_pk" PRIMARY KEY("user_id","page_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "favorites_ws_user_idx" ON "mod_quire"."favorites" USING btree ("workspace_id","user_id","position");--> statement-breakpoint

-- On `lower(name)`, not on `name`. Case is not a distinction anybody means here: "Draft" and "draft"
-- side by side in a picker read as broken data, and which one a person clicks is a coin toss.
CREATE UNIQUE INDEX IF NOT EXISTS "labels_ws_space_name_uq" ON "mod_quire"."labels" USING btree ("workspace_id","space_id",lower("name"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "labels_ws_space_idx" ON "mod_quire"."labels" USING btree ("workspace_id","space_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "page_labels_ws_label_idx" ON "mod_quire"."page_labels" USING btree ("workspace_id","label_id","page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recent_views_ws_user_idx" ON "mod_quire"."recent_views" USING btree ("workspace_id","user_id","viewed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watchers_ws_page_idx" ON "mod_quire"."watchers" USING btree ("workspace_id","page_id","user_id");--> statement-breakpoint

-- Row-level security, the same triple every tenant table gets.
--
-- `force` matters: without it the table owner bypasses the policy, and the owner is the role the
-- service connects as. A *superuser* bypasses RLS whatever this says, and the development and CI
-- roles are superusers — so a test that does not connect as an unprivileged role proves nothing
-- about isolation.
--
-- Note what is fenced and what is not. These five tables are keyed by a person, not only by a
-- workspace, and the policy is still on `workspace_id` alone: it is the tenant boundary, not a
-- privacy boundary. Keeping one person's favourites out of another's reading is the procedure's
-- job, and there is nothing here that does it yet.
ALTER TABLE "mod_quire"."labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."labels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "labels_ws_isolation" ON "mod_quire"."labels";--> statement-breakpoint
CREATE POLICY "labels_ws_isolation" ON "mod_quire"."labels"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

ALTER TABLE "mod_quire"."page_labels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."page_labels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "page_labels_ws_isolation" ON "mod_quire"."page_labels";--> statement-breakpoint
CREATE POLICY "page_labels_ws_isolation" ON "mod_quire"."page_labels"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

ALTER TABLE "mod_quire"."favorites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."favorites" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "favorites_ws_isolation" ON "mod_quire"."favorites";--> statement-breakpoint
CREATE POLICY "favorites_ws_isolation" ON "mod_quire"."favorites"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

ALTER TABLE "mod_quire"."recent_views" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."recent_views" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "recent_views_ws_isolation" ON "mod_quire"."recent_views";--> statement-breakpoint
CREATE POLICY "recent_views_ws_isolation" ON "mod_quire"."recent_views"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

ALTER TABLE "mod_quire"."watchers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."watchers" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "watchers_ws_isolation" ON "mod_quire"."watchers";--> statement-breakpoint
CREATE POLICY "watchers_ws_isolation" ON "mod_quire"."watchers"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
