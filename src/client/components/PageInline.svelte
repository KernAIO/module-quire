<script lang="ts">
import { Icon, navigation, session } from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { quireKeys } from '../query.js'

/**
 * How a Quire page reads when another module links to one — a mention in an issue, a search hit, a
 * notification. Inline presenters are how a module renders its own objects somewhere it does not own.
 */
interface Props {
  id: string
}
const { id }: Props = $props()

const api = getQuireApi()
const workspaceSlug = $derived(navigation.workspaceSlug)
const workspaceId = $derived(session.workspaces.find((w) => w.slug === workspaceSlug)?.id ?? '')

const query = createQuery(() => ({
  queryKey: quireKeys.page(workspaceId, id),
  enabled: Boolean(workspaceId && id),
  queryFn: () => api.pages.get({ workspaceId, pageId: id }),
}))
const title = $derived(query.data?.title?.trim() || t('untitled'))
</script>

<span class="inline">
  <Icon name="file-text" size={14} />
  <span class="t">{query.isLoading ? '…' : title}</span>
</span>

<style>
.inline {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--kern-ink-700);
}
.t {
  font-weight: 500;
}
</style>
