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
