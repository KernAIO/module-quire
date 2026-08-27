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

  /**
   * A space's vocabulary, and what one page wears out of it.
   *
   * `label` is the entity the server announces when one is created, renamed or removed, so a
   * rename reaches every chip drawing that label without anybody wiring an invalidation. Putting
   * labels *on* a page announces `page` instead — that is a change to the page — so
   * `pages.setLabels` invalidates this key itself.
   */
  labels: (workspaceId: string, spaceId: string) => ['quire', 'label', workspaceId, spaceId] as const,
  pageLabels: (workspaceId: string, pageId: string) =>
    ['quire', 'label', workspaceId, 'page', pageId] as const,

  /**
   * The three personal lists.
   *
   * Nothing on the server announces a change for these, and nothing should: one person starring a
   * page is not news to anybody else's open tab, and a `change` is broadcast to the whole
   * workspace. Their entities are therefore cache names rather than realtime names — the mutations
   * that write them answer with the whole list, so a screen redraws from the reply.
   */
  favorites: (workspaceId: string) => ['quire', 'favorite', workspaceId] as const,
  recents: (workspaceId: string) => ['quire', 'recent', workspaceId] as const,
  watchers: (workspaceId: string, pageId: string) => ['quire', 'watcher', workspaceId, pageId] as const,

  /**
   * Who has published what.
   *
   * `publication` is the entity `publications.create|update|remove` announce, so every screen
   * holding one of these keys redraws when somebody else publishes or takes a site down — which
   * matters more here than anywhere else in the module, because the thing that changed is whether
   * strangers can read a page.
   *
   * `site` is under the same entity on purpose. It is the *anonymous* read of a published site —
   * what the share dialog checks the URL against — and it is stale the instant the publication
   * changes, so it must be invalidated by the same announcement rather than by remembering to.
   */
  publications: (workspaceId: string, spaceId: string) =>
    ['quire', 'publication', workspaceId, spaceId] as const,
  site: (workspaceId: string, slug: string) => ['quire', 'publication', workspaceId, 'site', slug] as const,

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
