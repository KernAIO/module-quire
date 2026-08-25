import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { initialRank, rankBetween } from '../../client/rank.js'
import type { Database, Property, Row, View, ViewConfig } from '../../contract/index.js'
import {
  type Ast,
  evaluateFormula,
  type FormulaValue,
  formulaDependencies,
  parseFormula,
} from '../formula.js'
import { databases, pages, properties, relations, views } from '../schema.js'
import type { QuireAccess } from './access.js'
import { filterToSql, propertyFor, sortToSql } from './query.js'

type PropertyRow = typeof properties.$inferSelect
type ViewRow = typeof views.$inferSelect
type PageRow = typeof pages.$inferSelect

export const toProperty = (r: PropertyRow): Property => ({
  id: r.id,
  databaseId: r.databaseId,
  key: r.key,
  name: r.name,
  type: r.type as Property['type'],
  config: r.config as Property['config'],
  position: r.position,
  hidden: r.hidden,
})

export const toView = (r: ViewRow): View => ({
  id: r.id,
  databaseId: r.databaseId,
  name: r.name,
  kind: r.kind as View['kind'],
  config: r.config as ViewConfig,
  position: r.position,
  isDefault: r.isDefault,
})

export const toRow = (p: PageRow): Row => ({
  id: p.id,
  databaseId: p.databaseId ?? '',
  title: p.title,
  icon: p.icon,
  props: (p.props ?? {}) as Row['props'],
  computed: (p.computed ?? {}) as Row['computed'],
  createdBy: p.createdBy as Row['createdBy'],
  updatedBy: p.updatedBy as Row['updatedBy'],
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
})

/** A key derived from a name: what `props` is keyed by, so renaming a column keeps its data. */
function keyFrom(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'field'
  let key = base
  let n = 2
  while (taken.has(key)) key = `${base}_${n++}`
  return key
}

export function quireDatabases(kernel: Kernel, access: QuireAccess) {
  /** Parsed formulas, keyed by expression. Parsing is pure, so the cache never goes stale. */
  const formulaCache = new Map<string, Ast>()
  const astFor = (expression: string): Ast => {
    const hit = formulaCache.get(expression)
    if (hit) return hit
    const ast = parseFormula(expression)
    formulaCache.set(expression, ast)
    return ast
  }

  return {
    async get(tx: Tx, workspaceId: string, databaseId: string): Promise<Database> {
      const [db] = await tx
        .select()
        .from(databases)
        .where(and(eq(databases.workspaceId, workspaceId), eq(databases.id, databaseId)))
        .limit(1)
      if (!db) throw KernError.notFound('Database')
      const [props, vs] = await Promise.all([
        tx
          .select()
          .from(properties)
          .where(and(eq(properties.workspaceId, workspaceId), eq(properties.databaseId, databaseId)))
          .orderBy(asc(properties.position)),
        tx
          .select()
          .from(views)
          .where(and(eq(views.workspaceId, workspaceId), eq(views.databaseId, databaseId)))
          .orderBy(asc(views.position)),
      ])
      return {
        id: db.id,
        workspaceId: db.workspaceId,
        spaceId: db.spaceId,
        pageId: db.pageId,
        name: db.name,
        description: db.description,
        inline: db.inline,
        properties: props.map(toProperty),
        views: vs.map(toView),
        createdAt: db.createdAt.toISOString(),
        updatedAt: db.updatedAt.toISOString(),
      }
    },

    /**
     * Create a database on a page.
     *
     * It arrives with a title property and a table view, because a database with no columns and no
     * view is a screen with nothing on it and no obvious way forward.
     */
    async create(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      input: { spaceId: string; pageId: string; name: string; inline: boolean },
    ) {
      const id = uuidv7()
      await tx.insert(databases).values({
        id,
        workspaceId,
        spaceId: input.spaceId,
        pageId: input.pageId,
        name: input.name,
        inline: input.inline,
      })
      await tx.insert(properties).values({
        id: uuidv7(),
        workspaceId,
        databaseId: id,
        key: 'name',
        name: 'Name',
        type: 'text',
        config: {},
        position: initialRank(),
      })
      await tx.insert(views).values({
        id: uuidv7(),
        workspaceId,
        databaseId: id,
        name: 'Table',
        kind: 'table',
        config: {},
        position: initialRank(),
        isDefault: true,
      })
      /**
       * The host page is marked `database`, and deliberately does **not** get `database_id`.
       *
       * That column means "this page is a *row of* that database" and nothing else. Setting it here
       * as well made the database's own page appear as the first row of itself — present in every
       * view, with every cell empty, and impossible to explain.
       */
      await tx
        .update(pages)
        .set({ kind: 'database', updatedBy: principal.userId, updatedAt: new Date() })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, input.pageId)))
      return this.get(tx, workspaceId, id)
    },

    async addProperty(
      tx: Tx,
      workspaceId: string,
      databaseId: string,
      input: { name: string; type: Property['type']; config?: Property['config'] },
    ) {
      const existing = await tx
        .select({ key: properties.key, position: properties.position })
        .from(properties)
        .where(and(eq(properties.workspaceId, workspaceId), eq(properties.databaseId, databaseId)))
        .orderBy(asc(properties.position))
      const [row] = await tx
        .insert(properties)
        .values({
          id: uuidv7(),
          workspaceId,
          databaseId,
          key: keyFrom(input.name, new Set(existing.map((e) => e.key))),
          name: input.name,
          type: input.type,
          config: (input.config ?? {}) as Record<string, unknown>,
          position: rankBetween(existing.at(-1)?.position ?? null, null),
        })
        .returning()
      return toProperty(row!)
    },

    /**
     * Rename, retype or reconfigure a column.
     *
     * The `key` never changes, because it is what every row's `props` is keyed by — renaming a
     * column must not empty it. That is the whole reason a key exists separately from a name.
     */
    async updateProperty(
      tx: Tx,
      workspaceId: string,
      propertyId: string,
      patch: Partial<Pick<PropertyRow, 'name' | 'type' | 'config' | 'hidden' | 'position'>>,
    ) {
      const [row] = await tx
        .update(properties)
        .set(patch)
        .where(and(eq(properties.workspaceId, workspaceId), eq(properties.id, propertyId)))
        .returning()
      if (!row) throw KernError.notFound('Property')
      return toProperty(row)
    },

    async removeProperty(tx: Tx, workspaceId: string, propertyId: string) {
      const [row] = await tx
        .select()
        .from(properties)
        .where(and(eq(properties.workspaceId, workspaceId), eq(properties.id, propertyId)))
        .limit(1)
      if (!row) throw KernError.notFound('Property')
      // The values stay in `props`. Deleting a column by mistake is common, and the data coming
      // back when it is re-added costs one unused key per row.
      await tx
        .delete(properties)
        .where(and(eq(properties.workspaceId, workspaceId), eq(properties.id, propertyId)))
      await tx
        .delete(relations)
        .where(and(eq(relations.workspaceId, workspaceId), eq(relations.propertyId, propertyId)))
      return toProperty(row)
    },

    async addView(
      tx: Tx,
      workspaceId: string,
      databaseId: string,
      input: { name: string; kind: View['kind']; config?: Partial<ViewConfig> },
    ) {
      const existing = await tx
        .select({ position: views.position })
        .from(views)
        .where(and(eq(views.workspaceId, workspaceId), eq(views.databaseId, databaseId)))
        .orderBy(asc(views.position))
      const [row] = await tx
        .insert(views)
        .values({
          id: uuidv7(),
          workspaceId,
          databaseId,
          name: input.name,
          kind: input.kind,
          config: (input.config ?? {}) as Record<string, unknown>,
          position: rankBetween(existing.at(-1)?.position ?? null, null),
          isDefault: existing.length === 0,
        })
        .returning()
      return toView(row!)
    },

    async updateView(
      tx: Tx,
      workspaceId: string,
      viewId: string,
      patch: Partial<Pick<ViewRow, 'name' | 'kind' | 'config' | 'position'>>,
    ) {
      const [row] = await tx
        .update(views)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(views.workspaceId, workspaceId), eq(views.id, viewId)))
        .returning()
      if (!row) throw KernError.notFound('View')
      return toView(row)
    },

    async removeView(tx: Tx, workspaceId: string, viewId: string) {
      const [row] = await tx
        .select()
        .from(views)
        .where(and(eq(views.workspaceId, workspaceId), eq(views.id, viewId)))
        .limit(1)
      if (!row) throw KernError.notFound('View')
      if (row.isDefault) throw KernError.badRequest('A database keeps at least one view')
      await tx.delete(views).where(and(eq(views.workspaceId, workspaceId), eq(views.id, viewId)))
      return toView(row)
    },

    /**
     * The rows of a database, filtered and ordered by a view.
     *
     * Filtering happens in SQL rather than after the fact: a page of fifty rows filtered down to
     * three is not a page of three, and the caller has no way to ask for the rest.
     */
    async rows(
      tx: Tx,
      workspaceId: string,
      databaseId: string,
      opts: { view?: View | null; limit: number; cursor: string | null },
    ) {
      const db = await this.get(tx, workspaceId, databaseId)
      const config = opts.view?.config
      const conditions = [
        eq(pages.workspaceId, workspaceId),
        eq(pages.databaseId, databaseId),
        isNull(pages.deletedAt),
      ]

      const filters = (config?.filters ?? [])
        .map((f) => filterToSql(f, propertyFor(db.properties, f.propertyKey)))
        .filter((s): s is NonNullable<typeof s> => s !== null)
      if (filters.length > 0) {
        conditions.push(
          config?.filterMode === 'or'
            ? sql`(${sql.join(filters, sql` or `)})`
            : sql`(${sql.join(filters, sql` and `)})`,
        )
      }
      if (opts.cursor) conditions.push(sql`${pages.id} > ${opts.cursor}`)

      const orderBy = (config?.sorts ?? []).map((s) =>
        sortToSql(s, propertyFor(db.properties, s.propertyKey)),
      )
      // Always last, so ordering is total and the keyset cursor cannot skip or repeat a row.
      orderBy.push(sql`${pages.id} asc`)

      const found = await tx
        .select()
        .from(pages)
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(opts.limit + 1)

      const items = found.slice(0, opts.limit).map(toRow)
      return { items, nextCursor: found.length > opts.limit ? (items.at(-1)?.id ?? null) : null }
    },

    /**
     * Recompute the formulas and rollups of one row.
     *
     * Written into `computed` rather than calculated on read, so a view can filter and sort by a
     * formula in SQL like any other column. The cost is that a change has to say what it invalidates
     * — which is what `formulaDependencies` is for.
     */
    async recompute(tx: Tx, workspaceId: string, pageId: string) {
      const [row] = await tx
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        .limit(1)
      if (!row?.databaseId) return null

      const db = await this.get(tx, workspaceId, row.databaseId)
      const props = (row.props ?? {}) as Record<string, unknown>
      const byName = new Map(db.properties.map((p) => [p.name, p]))
      const computed: Record<string, unknown> = {}

      const rollups = db.properties.filter((p) => p.type === 'rollup')
      for (const property of rollups) {
        computed[property.key] = await this.rollup(tx, workspaceId, pageId, property, db.properties)
      }

      const read = (name: string): FormulaValue => {
        const property = byName.get(name)
        if (!property) return null
        const raw = property.type === 'rollup' ? computed[property.key] : props[property.key]
        if (raw === undefined || raw === null) return null
        if (typeof raw === 'number' || typeof raw === 'string' || typeof raw === 'boolean') return raw
        if (Array.isArray(raw)) return raw.length
        return String(raw)
      }

      for (const property of db.properties) {
        if (property.type !== 'formula') continue
        const expression = property.config.expression
        if (!expression) continue
        try {
          const value = evaluateFormula(astFor(expression), { prop: read })
          computed[property.key] = value instanceof Date ? value.toISOString() : value
        } catch (err) {
          // A broken formula shows as an error in its own cell rather than failing the write that
          // triggered it — somebody mistyping an expression must not stop the row being saved.
          computed[property.key] = { error: err instanceof Error ? err.message : 'Invalid formula' }
        }
      }

      await tx
        .update(pages)
        .set({ computed })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
      return computed
    },

    /** Gather the values on the other side of a relation and reduce them. */
    async rollup(
      tx: Tx,
      workspaceId: string,
      pageId: string,
      property: Property,
      all: Property[],
    ): Promise<unknown> {
      const via = property.config.rollupRelationPropertyId
      const target = property.config.rollupTargetPropertyId
      const fn = property.config.rollupFunction ?? 'count'
      if (!via) return null

      const linked = await tx
        .select({ id: relations.toPageId })
        .from(relations)
        .where(
          and(
            eq(relations.workspaceId, workspaceId),
            eq(relations.propertyId, via),
            eq(relations.fromPageId, pageId),
          ),
        )
      const ids = linked.map((l) => l.id)
      if (fn === 'count') return ids.length
      if (ids.length === 0) return fn === 'sum' || fn === 'average' ? 0 : null

      /**
       * The target column belongs to the database on the *other* side of the relation, not to the
       * one holding the rollup — so it is looked up by id rather than searched for among this
       * database's own properties, which is where it will never be. Getting that wrong makes every
       * rollup return zero, which reads as "the data is missing" rather than "the lookup is wrong".
       */
      const [targetRow] = target
        ? await tx
            .select()
            .from(properties)
            .where(and(eq(properties.workspaceId, workspaceId), eq(properties.id, target)))
            .limit(1)
        : []
      const targetProperty = targetRow ? toProperty(targetRow) : all.find((p) => p.id === target)
      const rows = await tx
        .select({ props: pages.props, computed: pages.computed })
        .from(pages)
        .where(and(eq(pages.workspaceId, workspaceId), inArray(pages.id, ids)))

      const values = rows
        .map((r) => {
          if (!targetProperty) return null
          const source = (
            targetProperty.type === 'formula' || targetProperty.type === 'rollup' ? r.computed : r.props
          ) as Record<string, unknown> | null
          return source?.[targetProperty.key] ?? null
        })
        .filter((v) => v !== null && v !== undefined)

      const numbers = values.map(Number).filter((n) => !Number.isNaN(n))
      switch (fn) {
        case 'count_values':
          return values.length
        case 'count_unique':
          return new Set(values.map((v) => JSON.stringify(v))).size
        case 'sum':
          return numbers.reduce((t, n) => t + n, 0)
        case 'average':
          return numbers.length ? numbers.reduce((t, n) => t + n, 0) / numbers.length : null
        case 'min':
          return numbers.length ? Math.min(...numbers) : null
        case 'max':
          return numbers.length ? Math.max(...numbers) : null
        case 'range':
          return numbers.length ? Math.max(...numbers) - Math.min(...numbers) : null
        case 'checked':
          return values.filter((v) => v === true).length
        case 'unchecked':
          return values.filter((v) => v !== true).length
        case 'percent_checked':
          return values.length ? (values.filter((v) => v === true).length / values.length) * 100 : null
        case 'show_original':
          return values
        default:
          return values.length
      }
    },

    /**
     * Set both ends of a relation.
     *
     * Symmetric by construction rather than by convention: a link set from one side that is not
     * visible from the other is the bug people report as "the rollup is wrong".
     */
    async setRelation(
      tx: Tx,
      workspaceId: string,
      propertyId: string,
      fromPageId: string,
      toPageIds: string[],
    ) {
      const [property] = await tx
        .select()
        .from(properties)
        .where(and(eq(properties.workspaceId, workspaceId), eq(properties.id, propertyId)))
        .limit(1)
      if (!property) throw KernError.notFound('Property')
      const inverse = (property.config as { relationPropertyId?: string }).relationPropertyId ?? null

      await tx
        .delete(relations)
        .where(
          and(
            eq(relations.workspaceId, workspaceId),
            eq(relations.propertyId, propertyId),
            eq(relations.fromPageId, fromPageId),
          ),
        )
      if (toPageIds.length > 0) {
        await tx.insert(relations).values(
          toPageIds.map((toPageId) => ({
            id: uuidv7(),
            workspaceId,
            propertyId,
            fromPageId,
            toPageId,
          })),
        )
      }

      if (inverse) {
        await tx
          .delete(relations)
          .where(
            and(
              eq(relations.workspaceId, workspaceId),
              eq(relations.propertyId, inverse),
              eq(relations.toPageId, fromPageId),
            ),
          )
        if (toPageIds.length > 0) {
          await tx.insert(relations).values(
            toPageIds.map((toPageId) => ({
              id: uuidv7(),
              workspaceId,
              propertyId: inverse,
              fromPageId: toPageId,
              toPageId: fromPageId,
            })),
          )
        }
      }

      // The rows on both sides may carry rollups over this relation.
      await this.recompute(tx, workspaceId, fromPageId)
      for (const id of toPageIds) await this.recompute(tx, workspaceId, id)
    },

    /**
     * Which other rows have to be recomputed because this one changed.
     *
     * Only the rows that roll up *through* a relation that reaches this one — recomputing the whole
     * database on every keystroke would be correct and unusable.
     */
    async dependentsOf(tx: Tx, workspaceId: string, pageId: string): Promise<string[]> {
      const rows = await tx
        .select({ id: relations.fromPageId })
        .from(relations)
        .where(and(eq(relations.workspaceId, workspaceId), eq(relations.toPageId, pageId)))
      return [...new Set(rows.map((r) => r.id))]
    },

    /** One row, after it has been written. */
    async rowById(tx: Tx, workspaceId: string, pageId: string): Promise<Row> {
      const [row] = await tx
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        .limit(1)
      if (!row) throw KernError.notFound('Row')
      return toRow(row)
    },

    /**
     * Write cells, merging rather than replacing.
     *
     * A table sends the cell somebody edited, not the whole row — replacing would blank every
     * column the client happened not to know about, which is every column added since it loaded.
     */
    async setRowFields(
      tx: Tx,
      workspaceId: string,
      pageId: string,
      databaseId: string | null,
      props: Record<string, unknown>,
    ) {
      const [existing] = await tx
        .select({ props: pages.props, databaseId: pages.databaseId })
        .from(pages)
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
        .limit(1)
      if (!existing) throw KernError.notFound('Row')
      const merged = { ...((existing.props ?? {}) as Record<string, unknown>), ...props }
      await tx
        .update(pages)
        .set({
          props: merged,
          databaseId: databaseId ?? existing.databaseId,
          updatedAt: new Date(),
        })
        .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
    },

    /** The columns a formula reads, so a property rename can report what it would break. */
    dependenciesOf(expression: string): string[] {
      try {
        return [...formulaDependencies(astFor(expression))]
      } catch {
        return []
      }
    },

    kernel,
  }
}
export type QuireDatabases = ReturnType<typeof quireDatabases>
