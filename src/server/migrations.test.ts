/**
 * Every migration must survive being applied twice.
 *
 * Not tidiness. `create policy`, `create table` and `create index` have no `if not exists` by
 * default, so a replay throws — and a module migration that throws takes down the **whole host
 * service**, not just its own module. `core` hosts five.
 *
 * A replay is not hypothetical: drizzle keys applied migrations by content hash, so regenerating
 * the journal (which happens whenever somebody re-runs `db:generate`) makes every file run again
 * against a schema that already has its objects.
 *
 * The idempotence assertion in quire.int.test.ts does NOT cover this — it calls `migrateModule`
 * twice, and the second call reads `__migrations`, sees the work is done and returns. Only replaying
 * the SQL itself reaches the failure.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TENANT_TABLES } from './schema.js'

const BASE = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB = `kern_quire_migrations_${Date.now().toString(36)}`
const DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations')

let admin: pg.Client
let client: pg.Client

const files = () =>
  readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()

/** Apply every migration in order, the way the kernel's runner does — statement by statement. */
async function applyAll(): Promise<string[]> {
  const failures: string[] = []
  for (const file of files()) {
    const sql = readFileSync(join(DIR, file), 'utf8')
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (!statement.trim()) continue
      try {
        await client.query(statement)
      } catch (err) {
        failures.push(`${file}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  return failures
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE })
  await admin.connect()
  await admin.query(`create database "${DB}"`)
  const url = new URL(BASE)
  url.pathname = `/${DB}`
  client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  // The kernel creates the schema before running a module's migrations.
  await client.query('create schema if not exists mod_quire')
}, 120_000)

afterAll(async () => {
  await client?.end().catch(() => undefined)
  await admin?.query(`drop database if exists "${DB}" with (force)`).catch(() => undefined)
  await admin?.end().catch(() => undefined)
}, 60_000)

describe('the migrations', () => {
  it('apply to an empty schema', async () => {
    expect(await applyAll()).toEqual([])
  })

  it('apply again without throwing, so a replay is a no-op and not a boot failure', async () => {
    expect(
      await applyAll(),
      'a module migration that throws takes down every module in the host service, not only its own',
    ).toEqual([])
  })

  it('leaves exactly one policy per tenant table, not a duplicate per replay', async () => {
    await applyAll()
    const { rows } = await client.query<{ tablename: string; n: string }>(
      `select tablename, count(*)::text as n from pg_policies
       where schemaname = 'mod_quire' group by tablename order by tablename`,
    )
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(Number(row.n), `${row.tablename} has ${row.n} policies`).toBe(1)
  })

  /**
   * The test above groups `pg_policies` by table, so a table with **no** policy is not a row with a
   * count of zero — it is absent from the result, and the loop never sees it. Dropping
   * `watchers_ws_isolation` from a database with the whole folder applied leaves both of the other
   * assertions in this file green. So the one thing a tenant table cannot do without is the one
   * thing nothing here was checking.
   *
   * `TENANT_TABLES` in `schema.ts` says it exists "so the RLS migration can be checked against one
   * list rather than memory", and until now nothing read it — the only other mention in the
   * repository is a comment at the top of `0001_rls.sql`. Five tables were added to it in this
   * change, which is exactly how a list stops being a check: it costs nothing to append to and
   * nothing notices when you don't.
   *
   * Both directions. A name in the list with no table is a migration that never ran; a table in the
   * schema with no name in the list is a tenant table nobody decided was one.
   */
  it('backs every name in TENANT_TABLES with a fenced table, and every table with a name', async () => {
    await applyAll()
    const { rows: tables } = await client.query<{ relname: string; enabled: boolean; forced: boolean }>(
      `select relname, relrowsecurity as enabled, relforcerowsecurity as forced from pg_class
       where relnamespace = 'mod_quire'::regnamespace and relkind = 'r' and relname <> '__migrations'`,
    )
    const { rows: policies } = await client.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies where schemaname = 'mod_quire'`,
    )
    const { rows: fenced } = await client.query<{ table_name: string }>(
      `select table_name from information_schema.columns
       where table_schema = 'mod_quire' and column_name = 'workspace_id'`,
    )

    const present = new Set(tables.map((r) => r.relname))
    const withWorkspaceId = new Set(fenced.map((r) => r.table_name))
    const policyCount = new Map<string, number>()
    for (const row of policies) policyCount.set(row.tablename, (policyCount.get(row.tablename) ?? 0) + 1)

    expect(
      TENANT_TABLES.filter((t) => !present.has(t)),
      'named in TENANT_TABLES but no such table — the migration that creates it is missing',
    ).toEqual([])
    expect(
      TENANT_TABLES.filter((t) => !withWorkspaceId.has(t)),
      'a tenant table with no workspace_id column cannot be fenced by the policy',
    ).toEqual([])
    expect(
      TENANT_TABLES.filter((t) => (policyCount.get(t) ?? 0) !== 1),
      'a tenant table without exactly one isolation policy — invisible to a group-by over pg_policies',
    ).toEqual([])
    expect(
      TENANT_TABLES.filter((t) => !tables.find((r) => r.relname === t)?.forced),
      'enable without force lets the table owner — the role the service connects as — read everything',
    ).toEqual([])
    expect(
      tables.map((r) => r.relname).filter((t) => !(TENANT_TABLES as readonly string[]).includes(t)),
      'a table in mod_quire that TENANT_TABLES does not name — decide whether it is tenant-scoped',
    ).toEqual([])
  })

  it('forces row-level security on every table it created', async () => {
    const { rows } = await client.query<{
      relname: string
      relrowsecurity: boolean
      relforcerowsecurity: boolean
    }>(
      `select relname, relrowsecurity, relforcerowsecurity from pg_class
       where relnamespace = 'mod_quire'::regnamespace and relkind = 'r' and relname <> '__migrations'
       order by relname`,
    )
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} has RLS off`).toBe(true)
      expect(row.relforcerowsecurity, `${row.relname} does not force RLS`).toBe(true)
    }
  })
})

/**
 * The other way a migration fails, and the only one nothing above can see.
 *
 * Everything in this file applies the folder to a database created from nothing, which is the right
 * way to prove the SQL is idempotent and the wrong way to notice this: it never reads the journal.
 * Drizzle's migrator takes the highest `created_at` already in `__migrations` **once**, before its
 * loop, and applies every entry whose `when` is above it. An entry below that floor is not applied
 * late — it is skipped, permanently, with no error. A fresh database has no floor to fall below, so
 * every developer machine, all of CI and every new install agree that nothing is wrong, and only a
 * deployment that already exists is missing the table.
 *
 * This journal is hand-edited — `0006_rank_collation` carries a round `when` nobody generated — so
 * the invariant is one somebody has to keep rather than one a tool keeps for them. `module-hr` keeps
 * the same check in its own `src/server/journal.test.ts`, after `0009_beyond_cap_minutes` shipped a
 * day below `0007` and would never have reached an instance.
 */
describe('the migration journal', () => {
  const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string }>
  }

  it('lists an entry for every migration file, and a file for every entry', () => {
    expect(journal.entries.map((e) => `${e.tag}.sql`).sort()).toEqual(files())
  })

  it('never lets a later migration carry an earlier timestamp', () => {
    let highest = Number.NEGATIVE_INFINITY
    let highestTag = '(none)'
    for (const entry of journal.entries) {
      expect(entry.idx, `${entry.tag} is out of order; the entries array is the apply order`).toBe(
        journal.entries.indexOf(entry),
      )
      expect(
        entry.when,
        `${entry.tag} has when=${entry.when}, below ${highestTag}'s ${highest}. Drizzle compares ` +
          'each entry against the highest timestamp already applied, so this file would be skipped ' +
          'on every database that has reached that one — silently, and only on databases that ' +
          'already exist. Raise it above the entry before it.',
      ).toBeGreaterThan(highest)
      highest = entry.when
      highestTag = entry.tag
    }
  })
})
