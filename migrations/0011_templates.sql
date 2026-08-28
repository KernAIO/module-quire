-- A page, or a whole space, saved so it can be made again.
--
-- Hand-written rather than generated, like 0001, 0006, 0008 and 0010, because drizzle-kit writes
-- neither the policy nor the guards. Every statement is idempotent: `create table`, `create index`
-- and `create policy` throw on a replay, and a module migration that throws takes down the **whole
-- host service** rather than its own module — `core` hosts five. Drizzle keys applied migrations by
-- content hash, so regenerating the journal replays every file against a schema that already has its
-- objects. The two `check` constraints are inline in `create table if not exists` on purpose: there
-- they inherit that guard, where a separate `alter table … add constraint` would need a
-- `drop constraint if exists` in front of it and is the shape that has broken this before.
--
--
-- WHERE THE FIVE STARTERS LIVE, AND WHY IT IS NOT IN THIS TABLE
--
-- Meeting notes, decision record, requirements, retrospective and how-to are **constants in the
-- module**, not rows seeded here. Three reasons, and the first one alone settles it.
--
-- *A migration has no workspace to seed into.* Every tenant table in `mod_quire` carries
-- `workspace_id NOT NULL` and is fenced by a policy that reads `app.workspace_id`. A migration runs
-- once per **database**, before any workspace exists and then never again — so a seeded row would
-- need either a nullable `workspace_id`, which makes `templates` the one table in this schema RLS
-- does not actually cover, or a second mechanism hooked to workspace creation, which then has to be
-- re-run against every workspace that already existed each time a sixth starter is added. Both are
-- worse than the thing they solve.
--
-- *A row is frozen at the release that wrote it.* Improving the retrospective starter in 0.15 does
-- nothing for a workspace created under 0.14, and making it do something means an `UPDATE` in a
-- migration — which overwrites whatever the customer changed. A constant improves for everybody on
-- the release that ships it, and overwrites nothing, because nothing was ever copied.
--
-- *A row holds one language.* Every user-facing string in Kern goes through `t()` in five locales.
-- A seeded row's name, description and prose would be English in an Arabic workspace for ever; a
-- constant's strings are message keys resolved per reader.
--
-- What that costs is the thing the trade is usually made for: a constant cannot be edited. That is
-- what `built_in` and `key` buy back, and how they work is written on the columns below.
CREATE TABLE IF NOT EXISTS "mod_quire"."templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"workspace_id" uuid NOT NULL,
	-- Null is a workspace-wide template, offered wherever a page is made. A space id scopes it to one
	-- space, which is what a team wanting their own "incident report" without putting it in everybody
	-- else's picker actually asks for. Nullable rather than two tables because every read is the same
	-- read — "what may I make here" — and a union of two tables to answer one question is how the
	-- workspace-wide half ends up quietly missing from one of the three places that asks.
	"space_id" uuid,
	-- `page` — one page, `doc` is its body.
	-- `space` — a whole space, `doc` is `{ pages: [...] }`, a tree of titles and bodies.
	-- Text with no check constraint, like `spaces.visibility`, `pages.kind` and `export_jobs.scope`:
	-- the enum in the contract is what closes these, and one column in the schema enforcing its domain
	-- in the database while eight do not teaches nothing except that the rule is arbitrary.
	"kind" text DEFAULT 'page' NOT NULL,
	-- Which shipped starter this row **replaces**, or null for somebody's own template.
	--
	-- A starter is a constant, so it has a stable key (`meeting-notes`, `decision-record`,
	-- `requirements`, `retrospective`, `how-to`) rather than a uuid — there is no row to have an id.
	-- The picker reads the constants and the rows together, and a row with a key takes the place of
	-- the starter it names instead of appearing beside it. So editing a starter is copy-on-write: the
	-- first edit in a workspace writes one row, before that there are none, and resetting is deleting
	-- that row — after which the shipped starter comes back, current and translated.
	--
	-- Deliberately **not** validated against the starter set, here or in the contract's row parser. A
	-- release that stops shipping a starter would otherwise turn every override of it into a parse
	-- failure, which is a picker that throws rather than a picker missing one entry. A key naming a
	-- starter that no longer exists is an ordinary custom template, and that is the read side's rule.
	"key" text,
	-- True exactly when this row occupies a shipped starter's slot — see `key`. The pair is what keeps
	-- the flag honest: something writes it (the first edit of a starter), something reads it (the
	-- picker, deciding whether to draw the constant or the row), and the check constraint below stops
	-- the two from drifting apart. A boolean nothing sets is the failure this project keeps naming
	-- about capabilities and permission keys, and it is the same failure here.
	"built_in" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	-- a Lucide icon name or an emoji, as everywhere else in this schema
	"icon" text,
	-- The body. A `PageDoc` for `kind = 'page'`; `{ pages: [ { title, icon, doc, children } ] }` for
	-- `kind = 'space'`. Always a JSON *object* rather than sometimes an array, so the default is a
	-- shape and not a lie, and so the two are told apart by their keys rather than by their type.
	--
	-- Whatever a person can write, a template can hold — which means this column is bound by the same
	-- rule as everything else that stores a page: a node the editor can produce and `renderPageDoc`
	-- cannot draw is a template that makes blank pages. Nothing here can check that; `render.test.ts`
	-- is what does.
	"doc" jsonb DEFAULT '{}'::jsonb NOT NULL,
	-- `[{ name, label, type, options, default, required }]` — what somebody is asked before the page
	-- is made, so `{{sprint}}` in the body becomes a sprint. `{{date}}` and `{{author}}` are not in
	-- here: they are filled from the request and need declaring by nobody.
	--
	-- JSONB rather than a `template_variables` table for the same reason `import_jobs.report` is a
	-- column: it is written whole, read whole, by one screen, nothing joins to an entry and no entry
	-- outlives its template. A table would be a second tenant table with its own `workspace_id`, its
	-- own policy and its own `TENANT_TABLES` entry to store a list of at most a dozen field
	-- definitions that are only ever fetched by `where template_id = $1`.
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	-- Nullable, like every other `created_by` in this schema and unlike the two job tables. A template
	-- is not an artefact that flattens other people's readerships into one file, so there is nothing
	-- here that has to be fenced to a person; a template whose author has left the workspace is still
	-- the team's template, and nulling the author must not take it away from them.
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- `key` is present exactly when `built_in` is true. Written as an equality rather than as two
	-- `or`ed halves because both sides are non-nullable booleans, so the constraint can never evaluate
	-- to NULL and be satisfied by accident — the usual way a check constraint stops checking.
	CONSTRAINT "templates_key_matches_built_in" CHECK ("built_in" = ("key" IS NOT NULL)),
	-- A space template makes a space, so it cannot live inside one. Without this the picker for space
	-- creation has to decide what a space-scoped space template means, and every answer is a guess.
	CONSTRAINT "templates_space_kind" CHECK ("kind" <> 'space' OR "space_id" IS NULL)
);
--> statement-breakpoint

-- The only read that matters, and it is one index rather than two.
--
-- "What may I make here" is `kind = 'page' and (space_id = $1 or space_id is null)`, and this is
-- what serves it — one index rather than a second one for the workspace-wide half.
--
-- `name` is last so the read is covered, not so the read comes back sorted: measured, the plan is an
-- index-only scan with the `or` applied as a filter inside it, and the `order by` is a sort over the
-- handful of rows that come out. That is the right trade at this size, and it is worth writing down
-- because the shape suggests otherwise — an index whose trailing column is the sort key usually does
-- supply the order, and here the disjunction on the column before it is what stops it.
--
-- There is deliberately **no** `(workspace_id, created_at desc)` index, unlike `export_jobs` and
-- `import_jobs` next door. Those accumulate a row per request for ever and are read newest-first;
-- a workspace has tens of templates, read by name, and an index nothing needs is a write nobody
-- asked for.
CREATE INDEX IF NOT EXISTS "templates_ws_kind_space_idx" ON "mod_quire"."templates" USING btree ("workspace_id","kind","space_id","name");--> statement-breakpoint

-- One override per starter per workspace. Two rows both claiming `retrospective` would make which
-- one the picker draws a coin toss, and "reset to the shipped one" would delete half the change.
-- Partial, because `key` is null on every template somebody wrote themselves and a plain unique
-- index over a nullable column constrains nothing at all in Postgres — NULLs never collide.
--
-- Names are **not** unique, in either direction. A workspace calling its own template "Meeting
-- notes" beside the starter of that name is a thing people mean to do, and a constraint refusing it
-- would be the database having an opinion about wording.
CREATE UNIQUE INDEX IF NOT EXISTS "templates_ws_key_uq" ON "mod_quire"."templates" USING btree ("workspace_id","key") WHERE "key" IS NOT NULL;--> statement-breakpoint

-- Row-level security, the same triple every tenant table gets.
--
-- `force` matters: without it the table owner bypasses the policy, and the owner is the role the
-- service connects as. A *superuser* bypasses RLS whatever this says, and the development and CI
-- roles are superusers — so a test that does not connect as an unprivileged NOBYPASSRLS role proves
-- nothing about isolation.
--
-- This is the tenant fence and nothing more. It does not decide who may *use* a template — a
-- space-scoped template belongs to a space, and whether the person asking may read that space is
-- settled by the procedure against the same space bindings as every other read in this module. Nor
-- does it decide what a template may *contain*: a template made from a page the author could read
-- carries that page's prose to whoever makes a page from it, which is a copy and not a leak, and is
-- the procedure's call at the moment of saving rather than this policy's.
ALTER TABLE "mod_quire"."templates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mod_quire"."templates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "templates_ws_isolation" ON "mod_quire"."templates";--> statement-breakpoint
CREATE POLICY "templates_ws_isolation" ON "mod_quire"."templates"
  USING (workspace_id::text = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id::text = current_setting('app.workspace_id', true));
