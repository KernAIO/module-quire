<script lang="ts">
import { navigation, relativeTime, SectionLabel, SidebarItem } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import type { RecentEntry, Space } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'

/**
 * Where this person has just been, newest first.
 *
 * Below the tree rather than above it: the tree is the space's table of contents and the thing
 * somebody came to the sidebar for, and a list that reorders itself every time you open a page is
 * a poor thing to put in front of it. Eight rows, because this answers "take me back" and not
 * "what have I read" — the row is a shortcut, and a long list of them stops being one.
 *
 * `recents.record` is called by the page screen on open; nothing here writes. The list is one
 * person's own — the server filters it by the caller, which is the only thing keeping it personal,
 * since row-level security fences the workspace rather than the reader.
 */
interface Props {
  workspaceId: string
  workspaceSlug: string
  spaces: readonly Space[]
  activePageId: string | null
}
const { workspaceId, workspaceSlug, spaces, activePageId }: Props = $props()

const api = getQuireApi()

const query = createQuery(() => ({
  queryKey: quireKeys.recents(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.recents.list({ workspaceId, limit: 8 }),
}))

const keyOf = $derived(new Map(spaces.map((s) => [s.id, s.key])))

/** Same as the favourites group: a row whose space has no key has nowhere to navigate to. */
const rows = $derived((query.data ?? []).filter((r) => keyOf.has(r.spaceId)))

const titleOf = (entry: RecentEntry) => entry.title.trim() || t('untitled')

const iconFor = (entry: RecentEntry) =>
  entry.kind === 'live' ? 'square-pen' : entry.kind === 'database' ? 'database' : 'file-text'

function open(entry: RecentEntry) {
  void navigation.go(
    `/${workspaceSlug}/quire/${encodeURIComponent(keyOf.get(entry.spaceId) ?? '')}/${encodeURIComponent(entry.pageId)}`,
  )
}
</script>

{#if rows.length > 0}
  <div class="group">
    <SectionLabel label={t('recent')} />
    <div class="stack">
      {#each rows as entry (entry.pageId)}
        <SidebarItem
          label={titleOf(entry)}
          icon={iconFor(entry)}
          active={activePageId === entry.pageId}
          onclick={() => open(entry)}
        >
          {#snippet trailing()}
            <!--
              A relative time, not a date: this list is only ever read as "how long ago", and
              `relativeTime` renders it in the interface language rather than as a raw number.
            -->
            <span class="when">{relativeTime(entry.viewedAt)}</span>
          {/snippet}
        </SidebarItem>
      {/each}
    </div>
  </div>
{/if}

<style>
.group {
  padding-block-start: 10px;
}
.stack {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
/*
 * Muted with a colour, never with `opacity` — and never smaller than 11.5px, which is where this
 * pane's ink stops being legible against its own background.
 */
.when {
  flex: none;
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-350);
  letter-spacing: -0.01em;
}
</style>
