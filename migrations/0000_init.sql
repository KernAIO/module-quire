CREATE SCHEMA IF NOT EXISTS "mod_quire";
--> statement-breakpoint
CREATE TABLE "mod_quire"."pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"parent_id" uuid,
	"position" text COLLATE "C" NOT NULL,
	"kind" text DEFAULT 'page' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"icon" text,
	"cover_url" text,
	"published_version_id" uuid,
	"has_unpublished_changes" boolean DEFAULT false NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mod_quire"."spaces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text,
	"visibility" text DEFAULT 'open' NOT NULL,
	"homepage_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "pages_ws_space_idx" ON "mod_quire"."pages" USING btree ("workspace_id","space_id","position");--> statement-breakpoint
CREATE INDEX "pages_ws_parent_idx" ON "mod_quire"."pages" USING btree ("workspace_id","parent_id","position");--> statement-breakpoint
CREATE INDEX "pages_ws_updated_idx" ON "mod_quire"."pages" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spaces_ws_key_uq" ON "mod_quire"."spaces" USING btree ("workspace_id","key");--> statement-breakpoint
CREATE INDEX "spaces_ws_idx" ON "mod_quire"."spaces" USING btree ("workspace_id","created_at");