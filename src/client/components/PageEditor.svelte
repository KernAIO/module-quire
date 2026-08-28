<script lang="ts">
import {
  CollaborativeEditor,
  type CollabPeer,
  type CollabStatus,
  type CommentRange,
  EmptyState,
  getHost,
  session,
} from '@kernhq/ui'
import { createQuery } from '@tanstack/svelte-query'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import { type Page, pageDocumentName } from '../index.js'
import { quireKeys } from '../query.js'
import PagePicker from './PagePicker.svelte'

/**
 * The body of a page, synchronised through the collab service.
 *
 * The document name is built with `formatCollabDocument` rather than assembled here: the gateway
 * parses it with the matching function from the same package, and a name it cannot parse is a
 * rejected connection with no useful error.
 */
interface Props {
  doc: Page
  onpeers?: (peers: CollabPeer[]) => void
  onstatus?: (status: CollabStatus) => void
  commentRanges?: CommentRange[]
  activeComment?: string | null
  onCommentClick?: (id: string) => void
  oncomment?: (anchor: { from: string; to: string }, quotedText: string) => void
}
const {
  doc,
  onpeers,
  onstatus,
  commentRanges = [],
  activeComment = null,
  onCommentClick,
  oncomment,
}: Props = $props()

const name = $derived(pageDocumentName(doc))

/**
 * Same-origin by default, so the dev proxy and the reverse proxy both work without configuration.
 * The shell owns the endpoint: same origin under `/collab` in every ordinary deployment, and an
 * explicit one for an instance that puts the collab service somewhere else.
 */
const url = $derived(
  getHost().collabUrl ??
    (typeof location === 'undefined' ? '' : `${location.origin.replace(/^http/, 'ws')}/collab`),
)

const user = $derived({
  id: session.user?.id ?? '',
  name: session.user?.name ?? '',
  avatarUrl: session.user?.avatarUrl ?? null,
})

/* ---------------------------------------------------------------------------------------------- */
/* The two macros that name another page                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Include page and include-an-excerpt need a page id, and `@kernhq/ui` cannot search for one.
 *
 * The `/` menu hides both entries unless the host passes `pickPage`, for the same reason it hides
 * Image without `pickImage`: a macro with no page draws an empty frame for every reader, so an entry
 * whose only possible outcome is an empty frame is worse than no entry. Without this wiring the two
 * macros were in the schema, in the renderer and in the resolver, and unreachable from the product.
 *
 * The menu awaits a promise, so dismissing the dialog has to resolve it — see `PagePicker`.
 */
let pickerOpen = $state(false)
let pending: ((picked: { pageId: string } | null) => void) | null = null

function pickPage(): Promise<{ pageId: string } | null> {
  return new Promise((resolve) => {
    // A picker already waiting answers "nothing" rather than being left holding an open promise.
    pending?.(null)
    pending = resolve
    pickerOpen = true
  })
}

function picked(page: { id: string; title: string } | null) {
  const resolve = pending
  pending = null
  pickerOpen = false
  if (page) titlesPicked.set(page.id, page.title)
  resolve?.(page ? { pageId: page.id } : null)
}

/**
 * The title a macro's card shows, resolved live and never stored.
 *
 * A title written into the document outlives the permission that allowed it: it would travel into
 * every export and every published copy and be drawn by a renderer that never asked anybody. So the
 * document holds the id, and this names it for the writer's own card, from what this session
 * already has — the space's tree, which the sidebar has usually loaded under this very key, plus
 * whatever was chosen in the picker (which is how a page in another space gets a name here).
 *
 * A page it cannot name is drawn as "Another page" rather than as "No page chosen": the card says
 * what it knows and does not invent the rest.
 */
const api = getQuireApi()
const treeQuery = createQuery(() => ({
  queryKey: quireKeys.tree(doc.workspaceId, doc.spaceId),
  enabled: Boolean(doc.workspaceId && doc.spaceId),
  queryFn: () =>
    api.pages.tree({ workspaceId: doc.workspaceId, spaceId: doc.spaceId, includeArchived: false }),
}))
const titlesInSpace = $derived(new Map((treeQuery.data ?? []).map((node) => [node.id, node.title])))
const titlesPicked = new Map<string, string>()

function macroPageLabel(pageId: string): string | null {
  const title = titlesInSpace.get(pageId) ?? titlesPicked.get(pageId) ?? null
  if (title === null) return null
  return title.trim() || t('untitled')
}
</script>

{#if getHost().isMock}
  <!--
    There is no collab service behind `dev:mock`, and an editor that silently fails to sync is worse
    than one that says so — this is the environment used for demos, where "it looked like it saved"
    is exactly the wrong impression to leave.
  -->
  <EmptyState icon="wifi-off" title={t('editor_mock')} description={t('editor_mock_desc')} />
{:else if !user.id}
  <EmptyState icon="triangle-alert" title={t('editor_no_session')} description={t('editor_no_session_desc')} />
{:else}
  {#key name}
    <!--
      `page` is what selects the wide wiki schema — tables, callouts, toggles, task lists, images,
      six heading levels. It is opt-in for a reason: a comment box shares this component and shares
      the narrow schema with issue descriptions, and only a page has a reader (`renderPageDoc`) able
      to draw all of this outside the browser.
    -->
    <!--
      `label` is not decoration: the surface carries `role="textbox"`, and a textbox with no
      accessible name is announced as nothing at all. This is the wiki's main writing surface, so
      it was the one control in the product that most needed a name and did not have one. The page
      title is the honest name for it; `page_body` covers an untitled page.
    -->
    <CollaborativeEditor
      {url}
      {name}
      {user}
      page
      placeholder={t('editor_placeholder')}
      label={doc.title || t('page_body')}
      {onpeers}
      {onstatus}
      {commentRanges}
      {activeComment}
      {onCommentClick}
      {oncomment}
      {pickPage}
      {macroPageLabel}
    />
  {/key}

  <!--
    Outside the `{#key name}` block: re-keying tears the editor down and rebuilds it, and a picker
    inside would be destroyed mid-choice with the `/` menu still awaiting its promise.
  -->
  <PagePicker
    bind:open={pickerOpen}
    workspaceId={doc.workspaceId}
    spaceId={doc.spaceId}
    excludeId={doc.id}
    onPick={picked}
  />
{/if}
