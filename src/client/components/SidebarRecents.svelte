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
            <span class="when" class:on-active={activePageId === entry.pageId}>
              {relativeTime(entry.viewedAt)}
            </span>
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
 *
 * **"Its own background" is two backgrounds, and the second one is the row you are standing on.**
 * `SidebarItem` paints an active row `--kern-ink-900` and switches its text to
 * `--kern-ink-inverse`; a timestamp that kept its own muted ink through that landed at **2.83:1 in
 * light and 2.50:1 in dark** — mid-grey on near-black, on the row of the page the reader currently
 * has open, in every locale. Off the active row the same colour is 4.88:1 or better against every
 * ground this pane uses, which is why the token was never the thing that was wrong.
 *
 * So the active row inherits instead of overriding: `--kern-ink-inverse` on `--kern-ink-900` is
 * 16.63:1 light and 15.52:1 dark. Inheriting rather than naming a second colour is also what keeps
 * the two in step if the active row is ever repainted.
 */
.when {
  flex: none;
  font-family: var(--kern-font-mono);
  font-size: 11.5px;
  color: var(--kern-ink-350);
  letter-spacing: -0.01em;
}
.when.on-active {
  color: inherit;
}
</style>
