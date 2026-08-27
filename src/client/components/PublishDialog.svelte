<script lang="ts">
import { Button, Dialog, Field, Icon, Input, relativeTime, Select, Switch, Textarea, toast } from '@kernhq/ui'
import { createQuery, useQueryClient } from '@tanstack/svelte-query'
import { untrack } from 'svelte'
import { getQuireApi } from '../api-instance.js'
import { t } from '../i18n.js'
import type { Page, PageNode, Publication } from '../index.js'
import { publicSiteUrl } from '../public-url.js'
import { quireKeys } from '../query.js'

/**
 * Putting a page on the internet, and taking it off again.
 *
 * **This is the one screen in Quire where a misunderstanding is a data leak**, and three things
 * follow from that rather than from taste:
 *
 * 1. **The consequence is stated above the control that causes it**, in a block nobody has to open,
 *    in the words somebody would use afterwards: anyone with the link, without signing in, this
 *    page *and everything under it*. A checkbox called "Public" with a tooltip is the shape of this
 *    screen that leaks a handbook.
 * 2. **What a stranger sees is measured, not claimed.** After publishing, the dialog calls the
 *    signed-out `public.site` — the same procedure the internet calls — and reports the number of
 *    pages that came back. That is the only line here that cannot be wrong: a root page nobody ever
 *    published produces a live URL and an empty site, which looks exactly like success from the
 *    inside and is a broken link to everybody else.
 * 3. **The per-page list says why a page is not on the site, not only whether it was opted out.**
 *    A switch on its own answers "did somebody exclude this", and the interesting question is "is
 *    this readable by strangers" — which a never-published page, an archived one and a child of an
 *    opted-out parent all answer differently and for different reasons.
 *
 * What this dialog deliberately does *not* do is decide who may publish. The menu entry that opens
 * it is gated on `quire.page.publish` for the rail's benefit, and every procedure it calls asks the
 * same permission about this page on the server. A person who reaches it another way gets refused
 * there, which is the only refusal that counts.
 */
interface Props {
  open?: boolean
  workspaceId: string
  workspaceSlug: string
  spaceId: string
  /** the page the site would be rooted at — its own published version is the front page */
  page: Pick<Page, 'id' | 'title' | 'publishedVersionId'>
}
let { open = $bindable(false), workspaceId, workspaceSlug, spaceId, page }: Props = $props()

const api = getQuireApi()
const client = useQueryClient()

// ------------------------------------------------------------------------------------------------
// What exists
// ------------------------------------------------------------------------------------------------

/**
 * Space-scoped, because that is the only listing the server offers — a publication has no
 * "for this page" read, and asking for one page's would be a second procedure saying the same
 * thing. The list is small (one row per published site in the space) and it is already the key a
 * `publication` announcement invalidates, so another tab publishing something redraws this one.
 */
const publicationsQuery = createQuery(() => ({
  queryKey: quireKeys.publications(workspaceId, spaceId),
  enabled: open && Boolean(workspaceId && spaceId),
  queryFn: () => api.publications.list({ workspaceId, spaceId }),
}))
const publication = $derived((publicationsQuery.data ?? []).find((row) => row.rootPageId === page.id) ?? null)
/**
 * Nothing is drawn until the list has arrived.
 *
 * "No publication yet" and "not asked yet" are the same value here, and rendering the first while
 * the second is true opens a published page on the *unpublished* screen — a "Publish to the web"
 * button for a site that already exists, which invites somebody to make a second one. It is a
 * flicker on a fast connection and a wrong screen on a slow one.
 */
const loading = $derived(publicationsQuery.isPending)

/**
 * The same key the sidebar holds, on purpose.
 *
 * Opening this dialog costs no request in the common case — the tree for the space somebody is
 * reading is already in the cache — and, more usefully, toggling a page here refreshes the sidebar
 * for free. `includeArchived: false` has to match the sidebar's call exactly or the two queries are
 * different queries wearing the same key.
 */
const treeQuery = createQuery(() => ({
  queryKey: quireKeys.tree(workspaceId, spaceId),
  enabled: open && Boolean(workspaceId && spaceId),
  queryFn: () => api.pages.tree({ workspaceId, spaceId, includeArchived: false }),
}))

/**
 * The signed-out read of the site, made from inside the app.
 *
 * `public.site` replaces the principal before it does anything, so this call is answered exactly as
 * it would be for a stranger — which is what makes the sentence it feeds honest rather than
 * reassuring. `retry: false` because the failure *is* the answer: an address that 404s should say
 * so at once, not after three attempts.
 */
const siteQuery = createQuery(() => ({
  queryKey: quireKeys.site(workspaceId, publication?.slug ?? ''),
  enabled: open && Boolean(workspaceId && publication),
  retry: false,
  queryFn: () => api.public.site({ workspaceId, slug: publication?.slug ?? '', token: null }),
}))

// ------------------------------------------------------------------------------------------------
// The form
// ------------------------------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')

let slug = $state('')
let includeDescendants = $state(true)
let indexable = $state(true)
let theme = $state<Publication['theme']>('auto')
let seoTitle = $state('')
let seoDescription = $state('')
let ogImageUrl = $state('')
let expiresOn = $state('')
/** empty means "leave the password alone" — never "there is no password". See `passwordPatch`. */
let password = $state('')
let dropPassword = $state(false)
let showMore = $state(false)
let error = $state<string | null>(null)
let confirmingUnpublish = $state(false)

/**
 * Which row the form was filled from, so it is filled once rather than on every render.
 *
 * An `$effect` that reads the fields it also writes is its own trigger, so `formFor` is read
 * through `untrack` — the effect depends on `open` and on the publication, and on nothing it sets.
 * Resetting it when the dialog closes is what makes reopening show what is stored rather than a
 * half-finished edit somebody abandoned.
 */
let formFor = $state<string | null>(null)

$effect(() => {
  const row = open ? publication : null
  const key = open ? (row?.id ?? 'new') : null
  if (untrack(() => formFor) === key) return
  formFor = key
  error = null
  password = ''
  dropPassword = false
  confirmingUnpublish = false
  if (key === null) return
  slug = row ? row.slug : (slugify(page.title) || 'page').slice(0, 64)
  includeDescendants = row ? row.includeDescendants : true
  indexable = row ? row.indexable : true
  theme = row ? row.theme : 'auto'
  seoTitle = row?.seoTitle ?? ''
  seoDescription = row?.seoDescription ?? ''
  ogImageUrl = row?.ogImageUrl ?? ''
  expiresOn = row?.expiresAt ? row.expiresAt.slice(0, 10) : ''
  showMore = false
})

const slugValid = $derived(slug.length >= 2 && slug.length <= 64 && SLUG_PATTERN.test(slug))

/**
 * The address that is **actually serving**, not the one in the box.
 *
 * Once a site exists the two can differ for as long as somebody is halfway through renaming it, and
 * the copy button is right there: a link box that followed the field would hand out a dead URL to
 * anybody who typed a character and then copied. Before there is a publication there is nothing to
 * be wrong about, so it follows the field — that is the whole point of showing it then.
 */
const url = $derived(
  publicSiteUrl({ workspaceSlug, slug: publication?.slug ?? (slugValid ? slug : 'your-page') }),
)
/** The address it becomes on save — shown as a sentence, so there are never two links on screen. */
const pendingUrl = $derived(
  publication && slugValid && slug !== publication.slug ? publicSiteUrl({ workspaceSlug, slug }) : null,
)

/**
 * `password` is three-valued at the contract and has to stay three-valued here.
 *
 * A string sets one, `null` removes one, and leaving the key out changes nothing. Collapsing that
 * into "whatever is in the box" is how a rename quietly takes the door off a handbook: the field is
 * empty on every visit, because a password is never read back.
 */
const passwordPatch = $derived<{ password?: string | null }>(
  dropPassword ? { password: null } : password.length > 0 ? { password } : {},
)

const settings = $derived({
  slug,
  includeDescendants,
  indexable,
  theme,
  seoTitle: seoTitle.trim(),
  seoDescription: seoDescription.trim(),
  ogImageUrl: ogImageUrl.trim() || null,
  expiresAt: expiresOn ? new Date(`${expiresOn}T23:59:59`).toISOString() : null,
})

const dirty = $derived.by(() => {
  const row = publication
  if (!row) return false
  if (dropPassword || password.length > 0) return true
  return (
    settings.slug !== row.slug ||
    settings.includeDescendants !== row.includeDescendants ||
    settings.indexable !== row.indexable ||
    settings.theme !== row.theme ||
    settings.seoTitle !== row.seoTitle ||
    settings.seoDescription !== row.seoDescription ||
    settings.ogImageUrl !== row.ogImageUrl ||
    (settings.expiresAt ?? '').slice(0, 10) !== (row.expiresAt ?? '').slice(0, 10)
  )
})

// ------------------------------------------------------------------------------------------------
// The pages underneath
// ------------------------------------------------------------------------------------------------

interface Descendant {
  node: PageNode
  depth: number
  /** an ancestor between this page and the root is opted out, so nothing here is reachable */
  blocked: boolean
}

const descendants = $derived.by((): Descendant[] => {
  const childrenOf = new Map<string, PageNode[]>()
  for (const node of treeQuery.data ?? []) {
    if (!node.parentId) continue
    childrenOf.set(node.parentId, [...(childrenOf.get(node.parentId) ?? []), node])
  }
  const out: Descendant[] = []
  const walk = (parentId: string, depth: number, blocked: boolean) => {
    for (const node of childrenOf.get(parentId) ?? []) {
      out.push({ node, depth, blocked })
      walk(node.id, depth + 1, blocked || node.excludedFromPublic)
    }
  }
  walk(page.id, 0, false)
  return out
})

/**
 * Why this page is not on the site — the first reason that applies, in the order somebody can act
 * on them. `null` means it is public, which is the only state that needs no explanation.
 */
function reasonFor(row: Descendant): string | null {
  if (row.node.excludedFromPublic) return t('share_child_private')
  if (row.node.archivedAt) return t('share_child_archived')
  if (!row.node.hasPublishedVersion) return t('share_child_draft')
  if (row.blocked) return t('share_child_blocked')
  return null
}

// ------------------------------------------------------------------------------------------------
// Doing it
// ------------------------------------------------------------------------------------------------

/* Set in the same tick as the click. `isPending` arrives a render late, so two quick clicks on
   "Publish" are one render apart and both get through — which here means two sites. */
let busy = false
let rowsBusy = $state<string[]>([])

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function refresh() {
  await client.invalidateQueries({ queryKey: quireKeys.publications(workspaceId, spaceId) })
  await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, spaceId) })
}

async function publish() {
  if (busy || !slugValid) return
  busy = true
  error = null
  try {
    await api.publications.create({
      workspaceId,
      rootPageId: page.id,
      ...settings,
      ...passwordPatch,
    })
    password = ''
    dropPassword = false
    await refresh()
    toast.success(t('share_published_toast'))
  } catch (err) {
    error = message(err)
  } finally {
    busy = false
  }
}

async function save() {
  const row = publication
  if (busy || !row || !slugValid) return
  busy = true
  error = null
  try {
    await api.publications.update({
      workspaceId,
      publicationId: row.id,
      ...settings,
      ...passwordPatch,
    })
    password = ''
    dropPassword = false
    await refresh()
    toast.success(t('share_saved'))
  } catch (err) {
    error = message(err)
  } finally {
    busy = false
  }
}

async function unpublish() {
  const row = publication
  if (busy || !row) return
  busy = true
  error = null
  try {
    await api.publications.remove({ workspaceId, publicationId: row.id })
    confirmingUnpublish = false
    await refresh()
    toast.success(t('share_unpublish_done'))
  } catch (err) {
    error = message(err)
  } finally {
    busy = false
  }
}

/**
 * Guarded rather than disabled: disabling the switch somebody just pressed blurs it, and the
 * browser hands that focus to `<body>` — so a keyboard user toggling three pages in a row loses
 * their place after the first one.
 */
async function setExcluded(node: PageNode, excluded: boolean) {
  if (rowsBusy.includes(node.id)) return
  rowsBusy = [...rowsBusy, node.id]
  try {
    await api.publications.optOut({ workspaceId, pageId: node.id, excluded })
    await client.invalidateQueries({ queryKey: quireKeys.tree(workspaceId, spaceId) })
    await client.invalidateQueries({ queryKey: quireKeys.site(workspaceId, publication?.slug ?? '') })
  } catch (err) {
    error = message(err)
  } finally {
    rowsBusy = rowsBusy.filter((id) => id !== node.id)
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(url)
    toast.success(t('share_copied'))
  } catch {
    // A denied clipboard is not worth an error toast: the link is on screen to select.
    toast.info(t('share_copy_manually'))
  }
}
</script>

<Dialog bind:open title={t('share_title')} size="lg">
  <div class="sheet">
  {#if loading}
    <p class="note">{t('loading')}</p>
  {:else if publicationsQuery.isError}
    <p class="error" role="alert">{t('page_error_desc')}</p>
  {:else}
    <!--
      The consequence, above the control that causes it, whether or not it has already happened.
      It is not a warning that appears when something is wrong — it is a description of what the
      button does, and it stays true after the button has been pressed.
    -->
    <section class="tell" class:live={publication !== null}>
      <Icon name={publication ? 'globe' : 'triangle-alert'} size={17} />
      <div class="tell-body">
        <p class="tell-title">{publication ? t('share_published') : t('share_warn_title')}</p>
        <p>{t('share_warn_body')}</p>
        <p>{t('share_warn_version')}</p>
        <p>{t('share_warn_unpublished')}</p>
        {#if indexable}<p>{t('share_warn_search')}</p>{/if}
      </div>
    </section>

    {#if !publication && page.publishedVersionId === null}
      <p class="caution" role="status">{t('share_needs_publish')}</p>
    {/if}

    <!-- The address, and the link it makes, side by side so one is visibly the other. -->
    <Field
      label={t('share_address')}
      hint={t('share_address_hint')}
      error={slugValid ? null : t('share_address_invalid')}
    >
      {#snippet children(id: string)}
        <Input
          {id}
          mono
          value={slug}
          oninput={(e: Event) => (slug = slugify((e.currentTarget as HTMLInputElement).value))}
        />
      {/snippet}
    </Field>

    <!--
      A heading rather than nothing. Read linearly — which is how a screen reader meets it — an
      unlabelled `<code>` between a form field and two buttons is a string of punctuation with no
      say in what it is. `aria-label` would have been the wrong fix: on an element with text content
      it *replaces* the text, so the one thing worth hearing would be the one thing hidden.
    -->
    <p class="link-label">{t('share_link')}</p>
    <div class="link">
      <code class="link-url">{url}</code>
      <Button size="sm" variant="secondary" icon="copy" onclick={() => void copyLink()}>
        {t('share_copy')}
      </Button>
      {#if publication}
        <Button
          size="sm"
          variant="ghost"
          icon="external-link"
          href={url}
          target="_blank"
          rel="noreferrer noopener"
        >
          {t('share_open')}
        </Button>
      {/if}
    </div>

    {#if pendingUrl}
      <p class="note" role="status">
        {t('share_address_pending')}
        <code class="inline-url">{pendingUrl}</code>
      </p>
    {/if}

    <!--
      Measured, not claimed. Everything else on this screen is what we intend to be true; this line
      is the only one that went and asked.
    -->
    {#if publication}
      <p class="check" role="status">
        {#if siteQuery.isPending}
          {t('share_check_running')}
        {:else if siteQuery.isError}
          <Icon name="triangle-alert" size={13} />{t('share_check_failed')}
        {:else if siteQuery.data?.locked}
          <Icon name="lock" size={13} />{t('share_check_locked')}
        {:else}
          <Icon name="check" size={13} />{t('share_check_ok', {
            count: siteQuery.data?.site?.nav.length ?? 0,
          })}
        {/if}
      </p>
      <p class="when">{t('share_published_when', { when: relativeTime(publication.createdAt) })}</p>
    {/if}

    <div class="switches">
      <Switch
        checked={includeDescendants}
        label={t('share_include')}
        description={t('share_include_desc')}
        onCheckedChange={(next: boolean) => (includeDescendants = next)}
      />
      {#if includeDescendants && descendants.length > 0}
        <p class="note">{t('share_count', { count: descendants.length })}</p>
      {/if}
    </div>

    <button type="button" class="more" onclick={() => (showMore = !showMore)}>
      <Icon name={showMore ? 'chevron-up' : 'chevron-down'} size={14} />
      {showMore ? t('share_less') : t('share_more')}
    </button>

    {#if showMore}
      <div class="form">
        <Switch
          checked={indexable}
          label={t('share_indexable')}
          description={t('share_indexable_desc')}
          onCheckedChange={(next: boolean) => (indexable = next)}
        />

        <Field
          label={t('share_password')}
          hint={publication?.hasPassword ? t('share_password_keep') : t('share_password_hint')}
        >
          {#snippet children(id: string)}
            <Input
              {id}
              type="password"
              autocomplete="new-password"
              bind:value={password}
              placeholder={publication?.hasPassword ? t('share_password_on') : ''}
            />
          {/snippet}
        </Field>
        {#if publication?.hasPassword}
          <Switch
            checked={dropPassword}
            label={t('share_password_remove')}
            onCheckedChange={(next: boolean) => (dropPassword = next)}
          />
        {/if}

        <Field label={t('share_expires')} hint={t('share_expires_hint')}>
          {#snippet children(id: string)}
            <Input {id} type="date" bind:value={expiresOn} />
          {/snippet}
        </Field>

        <Field label={t('share_theme')}>
          {#snippet children(id: string)}
            <Select
              {id}
              ariaLabel={t('share_theme')}
              value={theme}
              options={[
                { value: 'auto', label: t('share_theme_auto') },
                { value: 'light', label: t('share_theme_light') },
                { value: 'dark', label: t('share_theme_dark') },
              ]}
              onValueChange={(v: string) => (theme = v as Publication['theme'])}
            />
          {/snippet}
        </Field>

        <Field label={t('share_seo_title')} hint={t('share_seo_title_hint')}>
          {#snippet children(id: string)}
            <Input {id} bind:value={seoTitle} />
          {/snippet}
        </Field>

        <Field label={t('share_seo_description')}>
          {#snippet children(id: string)}
            <Textarea {id} bind:value={seoDescription} rows={2} />
          {/snippet}
        </Field>

        <Field label={t('share_og_image')} hint={t('share_og_image_hint')}>
          {#snippet children(id: string)}
            <Input {id} bind:value={ogImageUrl} placeholder="https://" />
          {/snippet}
        </Field>
      </div>
    {/if}

    <!--
      Only once the site exists. Before that the switches would write a flag against pages nobody is
      publishing, which is a real setting with no visible effect — and this list is the one place
      somebody looks to find out what is on the internet.
    -->
    {#if publication}
      <section class="children">
        <h3>{t('share_children')}</h3>
        {#if !includeDescendants}
          <p class="note">{t('share_children_off')}</p>
        {:else if treeQuery.isError}
          <!-- Never "nothing is nested under this page" because the tree failed to load: on this
               screen an empty list reads as a promise that nothing else is public. -->
          <p class="error" role="alert">{t('tree_error')}</p>
        {:else if treeQuery.isPending}
          <p class="note">{t('loading')}</p>
        {:else if descendants.length === 0}
          <p class="note">{t('share_children_none')}</p>
        {:else}
          <p class="note">{t('share_children_desc')}</p>
          <ul>
            {#each descendants as row (row.node.id)}
              {@const reason = reasonFor(row)}
              <!--
                The reason is a sibling of the switch, not its `description`.

                `Switch` puts a description inside its own `<label>` and names the control from the
                title alone, so a description is drawn on screen and reachable by nobody using a
                screen reader — and the reason is the whole difference between a switch that is on
                because the page is public and one that is on while the page is archived. As a
                paragraph in the list item it is read like any other content. No `ariaLabel` either:
                the visible title *is* the accessible name, which is the right pattern, and the prop
                would have been silently ignored beside a `label`.
              -->
              <li style={`--depth:${Math.min(row.depth, 6)}`}>
                <Switch
                  class="row-switch"
                  checked={!row.node.excludedFromPublic}
                  label={row.node.title.trim() || t('untitled')}
                  onCheckedChange={(next: boolean) => void setExcluded(row.node, !next)}
                />
                {#if reason}<p class="reason">{reason}</p>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if error}<p class="error" role="alert">{error}</p>{/if}
  {/if}
  </div>

  {#snippet footer()}
    <div class="foot">
      {#if loading || publicationsQuery.isError}
        <span class="spacer"></span>
        <Button variant="secondary" onclick={() => (open = false)}>{t('cancel')}</Button>
      {:else if publication}
        {#if confirmingUnpublish}
          <p class="ask">{t('share_unpublish_ask')}</p>
          <Button variant="secondary" size="sm" onclick={() => (confirmingUnpublish = false)}>
            {t('cancel')}
          </Button>
          <Button variant="danger" size="sm" onclick={() => void unpublish()}>
            {t('share_unpublish')}
          </Button>
        {:else}
          <Button variant="danger" size="sm" onclick={() => (confirmingUnpublish = true)}>
            {t('share_unpublish')}
          </Button>
          <span class="spacer"></span>
          {#if dirty}
            <Button disabled={!slugValid} onclick={() => void save()}>{t('share_save')}</Button>
          {:else}
            <Button variant="secondary" onclick={() => (open = false)}>{t('share_done')}</Button>
          {/if}
        {/if}
      {:else}
        <span class="spacer"></span>
        <Button variant="secondary" onclick={() => (open = false)}>{t('cancel')}</Button>
        <!--
          `disabled` for an address that cannot be a URL, and a plain flag inside `publish()` for the
          second click. They are different problems: the first is a statement about the form that the
          field beside it already explains, and the second is a race a disabled attribute loses,
          because it reaches the button one render after the click that should have been stopped.
        -->
        <Button disabled={!slugValid} onclick={() => void publish()}>{t('share_publish')}</Button>
      {/if}
    </div>
  {/snippet}
</Dialog>

<style>
.sheet {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/*
 * The sentence that matters. Warning-tinted before it is true and accent-tinted after, because
 * afterwards it is not a warning — it is the state of the page, and a permanent amber banner is a
 * thing people stop seeing.
 */
.tell {
  display: flex;
  gap: 10px;
  padding: 12px 13px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-warning-tint);
  color: var(--kern-ink-700);
}
.tell.live {
  background: var(--kern-accent-tint);
}
.tell-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.tell p {
  margin: 0;
  font-size: 13px;
  line-height: 1.55;
  text-wrap: pretty;
}
.tell-title {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--kern-ink-900);
}
.caution {
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--kern-r-lg);
  background: var(--kern-info-tint);
  color: var(--kern-ink-700);
  font-size: 13px;
  line-height: 1.55;
}

.link-label {
  margin: 0 0 -10px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--kern-ink-600);
}
.link {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 9px 11px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
  background: var(--kern-surface-input);
}
.link-url {
  flex: 1;
  min-width: 0;
  font-family: var(--kern-font-mono);
  font-size: 12.5px;
  color: var(--kern-ink-800);
  overflow-x: auto;
  white-space: nowrap;
  /* the address is Latin whichever way the page runs, and it is read left to right */
  direction: ltr;
  unicode-bidi: isolate;
  text-align: start;
}

.check,
.when {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: -8px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  /* muted with a colour: `opacity` fades this against the dialog until nobody can read it */
  color: var(--kern-ink-450);
}
.when {
  margin-block-start: -12px;
}

.switches {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-450);
  text-wrap: pretty;
}
/*
 * A URL is Latin and reads left to right whichever way the sentence around it runs. Without its own
 * direction the bidi algorithm lays it out against the paragraph's, and a Persian note about
 * `https://…/p/ws/handbook` comes apart at the slashes.
 */
.inline-url {
  display: inline-block;
  direction: ltr;
  unicode-bidi: isolate;
  font-family: var(--kern-font-mono);
  font-size: 12px;
  color: var(--kern-ink-700);
  overflow-wrap: anywhere;
}

.more {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 8px;
  margin-inline-start: -8px;
  border: 0;
  border-radius: var(--kern-r-md);
  background: none;
  color: var(--kern-ink-600);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.more:hover {
  background: var(--kern-surface-hover);
  color: var(--kern-ink-900);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--kern-border);
  border-radius: var(--kern-r-lg);
  background: var(--kern-surface-raised);
}

.children h3 {
  margin: 0 0 4px;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--kern-ink-900);
}
.children ul {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.children li {
  /* logical, so a Persian tree indents from the right like the sidebar does */
  padding-inline-start: calc(var(--depth) * 16px);
  padding-block: 5px;
  border-block-end: 1px solid var(--kern-border-hairline);
}
.children li:last-child {
  border-block-end: 0;
}
.children :global(.row-switch) {
  width: 100%;
}
.reason {
  margin: 0 0 2px;
  font-size: 12px;
  line-height: 1.45;
  color: var(--kern-ink-450);
}

.error {
  margin: 0;
  font-size: 13px;
  color: var(--kern-danger);
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  width: 100%;
}
.spacer {
  flex: 1;
}
.ask {
  flex: 1 1 220px;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--kern-ink-700);
  text-wrap: pretty;
}
</style>
