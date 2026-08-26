/**
 * Query keys, shaped `[module, entity, …scope]` so a realtime `change` message invalidates exactly
 * the queries it touches — `realtime.svelte.ts` in `@kernhq/ui` compares the `[module, entity]`
 * prefix.
 *
 * The entity names have to match what the server sends in `kernel.realtime.change`: `space`,
 * `page`, `database` and `row`. A key that spells one differently is a screen that never refreshes
 * and nobody notices until somebody else edits something.
 */
export const quireKeys = {
  spaces: (workspaceId: string) => ['quire', 'space', workspaceId] as const,
  space: (workspaceId: string, spaceId: string) => ['quire', 'space', workspaceId, spaceId] as const,
  tree: (workspaceId: string, spaceId: string) => ['quire', 'page', workspaceId, 'tree', spaceId] as const,
  page: (workspaceId: string, pageId: string) => ['quire', 'page', workspaceId, pageId] as const,
  trash: (workspaceId: string, spaceId: string) => ['quire', 'page', workspaceId, 'trash', spaceId] as const,

  /** the schema — properties and views — which every open tab of a database is drawing */
  database: (workspaceId: string, databaseId: string) =>
    ['quire', 'database', workspaceId, databaseId] as const,
  /** keyed under `database` too, because adding a column has to refresh the lookup that finds it */
  databaseForPage: (workspaceId: string, pageId: string) =>
    ['quire', 'database', workspaceId, 'page', pageId] as const,
  rows: (workspaceId: string, databaseId: string, viewId: string | null) =>
    ['quire', 'row', workspaceId, databaseId, viewId ?? 'default'] as const,
  /** a relation cell's search; `row` so any row edit re-resolves the names it draws */
  lookup: (workspaceId: string, databaseId: string, query: string) =>
    ['quire', 'row', workspaceId, databaseId, 'lookup', query] as const,
}
