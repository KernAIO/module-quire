/**
 * Query keys, shaped `[module, entity, …scope]` so a realtime `change` message invalidates exactly
 * the queries it touches — `lib/realtime.svelte.ts` compares the `[module, entity]` prefix.
 *
 * The entity names have to match what the server sends in `kernel.realtime.change`: `space` and
 * `page`. A key that spells one differently is a screen that never refreshes and nobody notices
 * until somebody else edits something.
 */
export const quireKeys = {
  spaces: (workspaceId: string) => ['quire', 'space', workspaceId] as const,
  space: (workspaceId: string, spaceId: string) => ['quire', 'space', workspaceId, spaceId] as const,
  tree: (workspaceId: string, spaceId: string) => ['quire', 'page', workspaceId, 'tree', spaceId] as const,
  page: (workspaceId: string, pageId: string) => ['quire', 'page', workspaceId, pageId] as const,
  trash: (workspaceId: string, spaceId: string) => ['quire', 'page', workspaceId, 'trash', spaceId] as const,
}
