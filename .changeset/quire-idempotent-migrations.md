---
'@kernhq/module-quire': patch
---

Make every migration survive being applied twice.

`create policy`, `create table` and `create index` have no `if not exists`, so a replay throws —
and a module migration that throws takes down the **whole host service**, not just its own module.
`core` hosts five. A replay is not hypothetical: drizzle keys applied migrations by content hash, so
regenerating the journal makes every file run again against a schema that already has its objects.

0001 created its two policies unguarded and 0000 created its tables and indexes unguarded. Both are
guarded now, and `src/server/migrations.test.ts` applies the whole set twice and asserts one policy
per table — the existing idempotence assertion could not catch this, because it calls
`migrateModule` twice and the second call reads `__migrations`, sees the work is done and returns.
