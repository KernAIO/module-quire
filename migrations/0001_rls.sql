-- Row-level security, one block per table in TENANT_TABLES.
--
-- `force` matters: without it the table owner bypasses the policy, and the owner is the role the
-- service connects as. Note that a *superuser* bypasses RLS whatever this says, and the development
-- and CI database roles are superusers — so a test that does not connect as an unprivileged role
-- proves nothing about isolation.
alter table "mod_quire"."spaces" enable row level security;--> statement-breakpoint
alter table "mod_quire"."spaces" force row level security;--> statement-breakpoint
create policy "spaces_ws_isolation" on "mod_quire"."spaces"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));--> statement-breakpoint

alter table "mod_quire"."pages" enable row level security;--> statement-breakpoint
alter table "mod_quire"."pages" force row level security;--> statement-breakpoint
create policy "pages_ws_isolation" on "mod_quire"."pages"
  using (workspace_id::text = current_setting('app.workspace_id', true))
  with check (workspace_id::text = current_setting('app.workspace_id', true));
