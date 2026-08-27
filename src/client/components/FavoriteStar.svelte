<script lang="ts">
import { IconButton } from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import type { FavoriteEntry } from '../../contract/index.js'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'

/**
 * The star on a page, and the one place a favourite is made.
 *
 * `favorites.list` is one query for the whole workspace and the sidebar is already holding it, so
 * this reads the same cache rather than asking whether this one page is starred — two screens that
 * ask separately are two screens that can disagree about it. Both mutations answer with the whole
 * ordered list, which goes straight into the cache: the sidebar redraws from the reply and nothing
 * refetches.
 *
 * Guarded with a plain flag rather than `disabled`. The attribute lands a render later, so a
 * double-click would star and unstar in one gesture; and disabling the button somebody has just
 * pressed blurs it and hands their focus to `<body>`. `aria-busy` says the same thing without
 * moving anything.
 */
interface Props {
  workspaceId: string
  pageId: string
}
const { workspaceId, pageId }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

const query = createQuery(() => ({
  queryKey: quireKeys.favorites(workspaceId),
  enabled: Boolean(workspaceId),
  queryFn: () => api.favorites.list({ workspaceId }),
}))

const starred = $derived((query.data ?? []).some((f) => f.pageId === pageId))
let busy = $state(false)

async function toggle() {
  if (busy || !workspaceId || !pageId) return
  busy = true
  try {
    const list: FavoriteEntry[] = starred
      ? await api.favorites.remove({ workspaceId, pageId })
      : await api.favorites.add({ workspaceId, pageId })
    client.setQueryData(quireKeys.favorites(workspaceId), list)
  } finally {
    busy = false
  }
}
</script>

<span class="star" class:on={starred}>
  <IconButton
    icon="star"
    variant="ghost"
    label={starred ? t('favorite_remove') : t('favorite_add')}
    aria-pressed={starred}
    aria-busy={busy}
    onclick={() => void toggle()}
  />
</span>

<style>
.star {
  display: inline-flex;
}
/*
 * A filled star, not a highlighted one. `Icon` draws a stroked outline, so "on" is the same glyph
 * flooded with its own colour — which is what makes the two states tell apart at a glance and in
 * a screenshot, where a background tint at this size does not.
 */
.star.on :global(.kib) {
  color: var(--kern-warning);
}
.star.on :global(.kib svg) {
  fill: currentColor;
}
</style>
