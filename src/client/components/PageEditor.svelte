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
import { t } from '../i18n.js'
import { type Page, pageDocumentName } from '../index.js'

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
    <CollaborativeEditor
      {url}
      {name}
      {user}
      page
      placeholder={t('editor_placeholder')}
      {onpeers}
      {onstatus}
      {commentRanges}
      {activeComment}
      {onCommentClick}
      {oncomment}
    />
  {/key}
{/if}
