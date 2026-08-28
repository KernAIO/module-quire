-- Getting work in and out: a request to export a page, a subtree or a space, and a request to import
-- a Notion, Confluence or Markdown export into a space.
--
-- Hand-written rather than generated, like 0001, 0006 and 0008, because drizzle-kit writes neither
-- the policy nor the guards. Every statement is idempotent: `create table`, `create index` and
-- `create policy` throw on a replay, and a module migration that throws takes down the **whole host
-- service** rather than its own module — `core` hosts five. Drizzle keys applied migrations by
-- content hash, so regenerating the journal replays every file against a schema that already has its
-- objects.
--
--
-- WHY THESE ARE ROWS AND NOT REQUESTS
--
-- The work is unbounded on both sides. A space is a tree of arbitrary size; PDF means a round trip to
-- Gotenberg per page; a Notion export is a zip with thousands of files in it. A job that outlives its
-- HTTP request is what lets progress be reported, a failure be read afterwards by somebody who was
-- not watching, and a retry happen without the browser having stayed open. That is the whole reason
-- `state`, `counts`, `error` and `finished_at` are columns rather than fields of a response.
--
--
-- WHAT THESE TABLES DO NOT DO
--
-- Neither of them is a permission. "You may not export a page you may not read" and "an import writes
-- only into a space you may write to" are decided by the procedure, against the same space bindings
-- every other read in this module goes through, before a row is written at all. The policy below is
-- the tenant fence and nothing more — it stops workspace B seeing workspace A's jobs, and it has
-- nothing to say about which pages within one workspace went into an artefact. Do not read a row's
-- existence as evidence that anybody was allowed to ask for it.
CREATE TABLE IF NOT EXISTS "mod_quire"."export_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	-- Not null, where every other `created_by` in this schema is nullable. The artefact is the hazard:
	-- a subtree export flattens pages with different readerships into one file, so whoever may fetch
	-- it may read everything that went into it. Fencing the download to the person who asked needs a
	-- person to fence it to, and a row whose requester has gone null cannot be fenced.
	"requested_by" uuid NOT NULL,
	-- `page` | `subtree` | `space`
	"scope" text NOT NULL,
	-- the page for `page` and `subtree`, the space for `space`; `scope` says which
	"target_id" uuid NOT NULL,
	-- `markdown` | `html` | `docx` | `pdf`
	"format" text NOT NULL,
	-- `queued` | `running` | `done` | `failed`
	"state" text DEFAULT 'queued' NOT NULL,
	-- The artefact in storage: written when the job finishes, null until then. Null while running is
	-- what keeps a half file from being offered — the uploader writes the bytes, then the job records
	-- the id, so this never points at a file that is still arriving. An id is not a URL: the download
	-- is a signed URL a procedure mints, never a storage key a client assembles. See 0009 for what
	-- that rule cost the last time it was broken.
	"file_id" uuid,
	-- Diagnostic text, in the language of whatever failed. Not a user-facing string: what a screen
	-- shows comes from a message key chosen from `state`, and this is what makes the same failure
	-- answerable a week later.
	"error" text,
	-- `{ total, done, skipped, failed }`. `skipped` is load-bearing: a subtree export by somebody who
	-- may not read one of its children leaves that child out, and the count is the difference between
	-- an export that is missing pages and an export that says so.
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- null while `queued` or `running`; set once, on the move to `done` or `failed`
	"finished_at" timestamp with time zone
);
--> statement-breakpoint

-- The same shape pointed the other way, with one addition that carries the weight of the feature.
--
-- `report` is jsonb rather than a table, and that is a decision rather than a shortcut.
--
-- It is written by one job and read whole, as one document, by one screen: the person who ran the
-- import looking at what happened to their import. Nothing joins to an entry, nothing updates an
-- entry after the fact, nothing holds a foreign key into one, and no entry outlives its job. A
-- row-per-file table would be four thousand inserts to render a list only ever fetched by
-- `where job_id = $1`, plus a second tenant table with its own `workspace_id`, its own policy, its
-- own `TENANT_TABLES` entry and its own retention rule — all to store a document. Here, dropping the
-- job drops its report; there is nothing to sweep. The size is the part worth checking rather than
-- assuming: an entry is a path, one of three words, and either a uuid or a sentence, so a
-- five-thousand-file import is a few hundred kilobytes — one TOASTed value, read once.
--
-- **What would change if somebody wanted to query across imports** — "every file that failed for this
-- reason, across every import this month" — is that this stops being the right shape, and not by a
-- little. `jsonb_array_elements` over the whole table can answer it, but no index helps: a GIN index
-- on the column serves containment (`@>`), not a predicate plus an ordering inside the array. The
-- change is a `mod_quire.import_entries` table — `job_id`, `workspace_id`, `path`, `outcome`,
-- `page_id`, `reason` — indexed on `(workspace_id, outcome, created_at)`, written by the same worker,
-- with the existing rows backfilled by expanding this column through `jsonb_to_recordset`. It is a
-- tenant table, so it arrives with the full triple and a `TENANT_TABLES` entry, and it needs the
-- retention rule the column gets for free. The threshold is exactly that question: while every read
-- names one job, the column is right.
CREATE TABLE IF NOT EXISTS "mod_quire"."import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	-- not null for the same reason as `export_jobs.requested_by`
	"requested_by" uuid NOT NULL,
	-- `notion` | `confluence` | `markdown`
	"source" text NOT NULL,
	-- the space being written into. An import always targets one space; there is no `scope` here.
	"target_id" uuid NOT NULL,
	-- The uploaded archive, and **not** called `file_id` on purpose. `export_jobs.file_id` is the file
	-- a job produces and is null until it succeeds; this is the file a job consumes and exists before
	-- the job does. One name pointing in two directions across two tables read by one screen is how a
	-- worker writes its output id over the pointer to its input — losing the archive, so the job
	-- cannot be retried and nothing reports that anything went missing.
	"source_file_id" uuid NOT NULL,
	-- `queued` | `running` | `done` | `failed`
	"state" text DEFAULT 'queued' NOT NULL,
	-- why the *job* failed; why one *file* failed is that file's entry in `report`
	"error" text,
	-- `{ total, done, skipped, failed }` — the same counters as an export, over files rather than pages
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- one entry per file: `{ path, outcome, pageId, reason }`, where outcome is imported|skipped|failed
	"report" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- null while `queued` or `running`; set once, on the move to `done` or `failed`
	"finished_at" timestamp with time zone
);
--> statement-breakpoint

-- Newest first, because that is the only order a list of jobs is ever read in — the one you just
-- started is the one you are looking for. `DESC NULLS LAST` rather than a plain index scanned
-- backwards so the ordering is the index's own, matching `recent_views_ws_user_idx` in 0007.
CREATE INDEX IF NOT EXISTS "export_jobs_ws_created_idx" ON "mod_quire"."export_jobs" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint

-- "What is still running here", asked by the worker picking up work and by every client polling a
-- job it started. Leading with the state after the workspace keeps that probe off the rows of every
-- export the workspace has ever finished.
CREATE INDEX IF NOT EXISTS "export_jobs_ws_state_idx" ON "mod_quire"."export_jobs" USING btree ("workspace_id","state","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_jobs_ws_created_idx" ON "mod_quire"."import_jobs" USING btree ("workspace_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_jobs_ws_state_idx" ON "mod_quire"."import_jobs" USING btree ("workspace_id","state","created_at");--> statement-breakpoint

-- Row-level security, the same triple every tenant table gets.
--
-- `force` matters: without it the table owner bypasses the policy, and the owner is the role the
-- service connects as. A *superuser* bypasses RLS whatever this says, and the development and CI
-- roles are superusers — so a test that does not connect as an unprivileged NOBYPASSRLS role proves
-- nothing about isolation.
--
-- Note what this does and does not fence, because these two tables invite the wrong reading. It is
-- the tenant boundary: workspace B cannot see workspace A's jobs, in either direction. It says
-- nothing about which *pages* went into an artefact, nothing about whether the requester was allowed
-- to ask, and nothing about who may download the result. Those are the procedure's job, decided
-- against the same space bindings as every other read in this module, before the row exists.
ALTER TABLE "mod_quire"."export_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."export_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "export_jobs_ws_isolation" ON "mod_quire"."export_jobs";--> statement-breakpoint
CREATE POLICY "export_jobs_ws_isolation" ON "mod_quire"."export_jobs"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

ALTER TABLE "mod_quire"."import_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."import_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "import_jobs_ws_isolation" ON "mod_quire"."import_jobs";--> statement-breakpoint
CREATE POLICY "import_jobs_ws_isolation" ON "mod_quire"."import_jobs"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
