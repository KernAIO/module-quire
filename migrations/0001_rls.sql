-- Row-level security, one block per table in TENANT_TABLES.
--
-- Every statement here is idempotent, and that is not tidiness. `create policy` has no
-- `if not exists`, so a replay throws — and a module migration that throws takes down the whole
-- host service rather than its own module. `core` hosts five. A replay is not hypothetical: drizzle
-- keys applied migrations by content hash, so regenerating the journal is enough to make every file
-- run again against a schema that already has its objects.
--
-- `force` matters: without it the table owner bypasses the policy, and the owner is the role the
-- service connects as. Note that a *superuser* bypasses RLS whatever this says, and the development
-- and CI database roles are superusers — so a test that does not connect as an unprivileged role
-- proves nothing about isolation.
alter table "mod_quire"."spaces" enable row level security;--> statement-breakpoint
alter table "mod_quire"."spaces" force row level security;--> statement-breakpoint
drop policy if exists "spaces_ws_isolation" on "mod_quire"."spaces";--> statement-breakpoint
create policy "spaces_ws_isolation" on "mod_quire"."spaces"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_quire"."pages" enable row level security;--> statement-breakpoint
alter table "mod_quire"."pages" force row level security;--> statement-breakpoint
drop policy if exists "pages_ws_isolation" on "mod_quire"."pages";--> statement-breakpoint
create policy "pages_ws_isolation" on "mod_quire"."pages"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
