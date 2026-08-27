-- Publishing a page, and everything under it, to a URL a signed-out stranger can open.
--
-- Hand-written rather than generated, like 0001 and 0006, because drizzle-kit writes neither the
-- policy nor the guards. Every statement is idempotent: `create table`, `create index` and
-- `create policy` throw on a replay, and a module migration that throws takes down the **whole host
-- service** rather than its own module — `core` hosts five. Drizzle keys applied migrations by
-- content hash, so regenerating the journal replays every file against a schema that already has its
-- objects. `add column if not exists` covers the two columns added to existing tables.
--
--
-- HOW AN ANONYMOUS READ REACHES THIS TABLE
--
-- This is the question the table exists to answer, so it is answered here rather than left to be
-- rediscovered. A public endpoint is the only surface in Kern with no principal behind it, and the
-- fence every other table leans on is `current_setting('app.workspace_id')`, which a session sets
-- from the principal it authenticated. There is no principal here. So one of three things is true,
-- and which one it is has to be a decision rather than an accident:
--
--   1. `app.workspace_id` is unset, the policy matches nothing, and the endpoint returns an empty
--      page for every publication that exists.
--   2. Somebody notices (1), writes the public query without the workspace, and it returns every
--      row in every tenant. This is the failure that matters. It does not look like a bug: the page
--      renders, the content is real, and it belongs to a customer who never published it.
--   3. The request carries a workspace, and the ordinary policy does its ordinary job.
--
-- **Kern takes (3), and (1) is what a mistake degrades to.** *Anonymous* means no principal; it does
-- not mean no tenant. A public URL is workspace-qualified — `/api/quire/public/:workspace/:slug` —
-- so the handler resolves the workspace segment against `core`'s own workspaces (outside this schema
-- and outside this module) and calls `withWorkspace(id, …)` before it touches `mod_quire` at all.
-- From that point the policy below is the plain workspace policy every other table has, and nothing
-- about the public path is special at the RLS layer. That is the point: a surface with no principal
-- is not the place to invent a second isolation mechanism.
--
-- The degradation is safe by construction, and it is worth knowing why. `withWorkspace(null, …)`
-- sets the GUC to the empty string, not to NULL, and `workspace_id::text` is a uuid — never `''`.
-- So a quire query that reaches the database with no workspace resolved returns **zero rows**, on
-- every table in this schema. A broken public path shows an empty page. It does not show somebody
-- else's.
--
-- Two rules follow, and neither is optional:
--
--   * **Do not widen this policy with an anonymous clause.** The obvious shape — `OR slug =
--     current_setting('app.quire_publication_slug', true)` — reads like a tightening and is not one.
--     `DELETE` is governed by `USING` alone (there is no `WITH CHECK` for delete), so any clause
--     that makes a row visible to a session with no workspace also makes it deletable by one. The
--     asymmetry is easy to miss because `INSERT` and `UPDATE` *are* covered by `WITH CHECK`. Splitting
--     it into a `FOR SELECT` policy plus a `FOR ALL` policy would close that, and `migrations.test.ts`
--     requires exactly one policy per tenant table, so it is not available either.
--   * **Run the public path in a `READ ONLY` transaction.** Once the handler has set
--     `app.workspace_id`, RLS has stopped being a fence around the public request — the whole
--     workspace is inside it, which is exactly right for reading a publication and exactly wrong for
--     everything else. `set transaction read only` makes every write in that transaction fail with
--     25006, in Postgres rather than in a code review, and it covers `pages` and `page_versions` too.
--
-- And the rule the fence cannot enforce: **every query on the public path carries the publication in
-- its own `WHERE`.** The workspace is set, so RLS will happily return a page in another space that
-- nobody published. Scope by publication — the root page, its descendants when `include_descendants`,
-- `excluded_from_public` false, and a non-null `published_version_id` — not by workspace and hope.
CREATE TABLE IF NOT EXISTS "mod_quire"."publications" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"root_page_id" uuid NOT NULL,
	"include_descendants" boolean DEFAULT true NOT NULL,
	"slug" text NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"seo_title" text DEFAULT '' NOT NULL,
	"seo_description" text DEFAULT '' NOT NULL,
	"og_image_url" text,
	"indexable" boolean DEFAULT true NOT NULL,
	"theme" text DEFAULT 'auto' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- The per-page opt-out, so one child can stay private under a public parent.
--
-- A column on the page rather than a `publication_exclusions` join table, and the reason is which
-- way each one fails. An exclusion row is written against *one* publication, so publishing a new
-- root above the page later re-exposes it — silently, to whoever creates that publication, who never
-- saw the opt-out because it belonged to a different row. A column travels with the page: it means
-- "never public", it holds against publications that do not exist yet, and the tree walk reads it
-- from the row it already has instead of remembering an anti-join on the one surface where a
-- forgotten join is a leak. What it costs is per-publication precision — a page cannot be public in
-- the handbook and private in the onboarding guide. That is a real limitation and the safer half of
-- the trade; a table can be added *beside* this column later, with the column keeping its meaning as
-- the absolute one.
--
-- Backward compatible: an image without this migration reads `pages` exactly as it did.
ALTER TABLE "mod_quire"."pages" ADD COLUMN IF NOT EXISTS "excluded_from_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- What the version looked like, rendered once at publish time.
--
-- A public read must not decode a CRDT. `versions.html` renders a Y.Doc through the Tiptap schema on
-- every call, which is the right answer for a signed-in reader looking at history and the wrong one
-- for an endpoint an anonymous crawler hits — the work is identical every time because the version
-- is immutable. Storing it makes a public page a single indexed row read, and it is what lets the
-- response be cached by version id.
--
-- Nullable, and deliberately not backfilled to `''`. An empty string would claim "this version
-- renders to nothing"; NULL says "nobody has rendered it", which is the truth for every version
-- written before this migration. A publication whose pinned version has no HTML is not servable —
-- which lines up with the rule that a page with no published version is not public at all.
ALTER TABLE "mod_quire"."page_versions" ADD COLUMN IF NOT EXISTS "html" text;--> statement-breakpoint

-- The public path lookup, and the uniqueness rule, in one index.
--
-- `where workspace_id = $1 and slug = $2` is the first query of every anonymous request, so it is a
-- two-column equality probe rather than anything that touches a heap page it did not have to. The
-- slug is unique per workspace and not beyond it: the workspace is in the URL, so two customers both
-- wanting `handbook` is not a collision, and making it instance-wide would let whoever published
-- first take the word from everybody else.
CREATE UNIQUE INDEX IF NOT EXISTS "publications_ws_slug_uq" ON "mod_quire"."publications" USING btree ("workspace_id","slug");--> statement-breakpoint

-- "Is this page published, and where?" — asked on every page an author opens, and again whenever a
-- page is archived, moved or deleted, because a publication rooted at it has to be dealt with.
CREATE INDEX IF NOT EXISTS "publications_ws_root_idx" ON "mod_quire"."publications" USING btree ("workspace_id","root_page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "publications_ws_created_idx" ON "mod_quire"."publications" USING btree ("workspace_id","created_at");--> statement-breakpoint

-- Row-level security, the same triple every tenant table gets, and no more than that — see the note
-- at the top of this file for why the anonymous case does not get a clause of its own.
--
-- `force` matters: without it the table owner bypasses the policy, and the owner is the role the
-- service connects as. A *superuser* bypasses RLS whatever this says, and the development and CI
-- roles are superusers — so a test that does not connect as an unprivileged NOBYPASSRLS role proves
-- nothing about isolation.
--
-- One thing this policy does not do is protect a column. RLS is row-level, so `password_hash` is
-- inside every row the workspace can read, including on the public path once the handler has set the
-- workspace. Select it into the verification step and nowhere else — never into a response body, an
-- event payload or a log line. It is a PHC string (`$argon2id$…`), which is a hash and a salt and a
-- cost, and it is still the one column here that must not leave the server.
ALTER TABLE "mod_quire"."publications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."publications" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "publications_ws_isolation" ON "mod_quire"."publications";--> statement-breakpoint
CREATE POLICY "publications_ws_isolation" ON "mod_quire"."publications"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
