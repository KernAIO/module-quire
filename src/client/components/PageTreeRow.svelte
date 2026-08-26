<script lang="ts">
import { Icon, IconButton, SidebarItem } from '@kernhq/ui'
import { t } from '../i18n.js'
import type { PageTreeNode } from '../index.js'
import PageTreeRow from './PageTreeRow.svelte'

/**
 * One row of the page tree, and its children.
 *
 * Recursive rather than flattened: the disclosure state belongs to the row that owns it, and a
 * flattened list has to carry a depth on every node just to indent it. `SidebarItem` draws the row
 * so indentation, the active state and RTL come from the design system rather than from here —
 * `indent` caps at 2 there, so deeper levels stop stepping in rather than marching off the edge of a
 * 268px column.
 */
interface Props {
  node: PageTreeNode
  depth: number
  activeId: string | null
  expanded: Set<string>
  onToggle: (id: string) => void
  onOpen: (id: string) => void
  onCreateChild: (id: string) => void
  canCreate: boolean
}

const { node, depth, activeId, expanded, onToggle, onOpen, onCreateChild, canCreate }: Props = $props()

const isOpen = $derived(expanded.has(node.id))
const title = $derived(node.title.trim() || t('untitled'))
const indent = $derived(Math.min(depth, 2) as 0 | 1 | 2)
</script>

<div class="row">
  <!--
    Disclosure first, row second, add last — DOM order *is* tab order, and both of the other two are
    positioned over the row rather than laid out in it. Written the other way round the keyboard
    reached a page's chevron only after passing the page itself, which is not where it is drawn.
  -->
  {#if node.hasChildren}
    <button
      class="twisty"
      type="button"
      style:inset-inline-start="{indent * 22 - 4}px"
      aria-label={isOpen ? t('collapse', { title }) : t('expand', { title })}
      aria-expanded={isOpen}
      onclick={() => onToggle(node.id)}
    >
      <span class:open={isOpen}><Icon name="chevron-right" size={11} strokeWidth={2} /></span>
    </button>
  {/if}

  <SidebarItem
    label={title}
    icon={node.kind === 'live' ? 'square-pen' : node.kind === 'database' ? 'database' : 'file-text'}
    active={activeId === node.id}
    {indent}
    onclick={() => onOpen(node.id)}
  >
    {#snippet trailing()}
      {#if node.archivedAt}
        <span class="flag" title={t('archived')}><Icon name="archive" size={12} /></span>
      {/if}
      <!--
        Room for the add button, which is not in here. `SidebarItem` is a `<button>`, so anything
        interactive inside it is a button inside a button: invalid, and the row's accessible name
        becomes "Welcome New page inside Welcome" because the name of a button is its contents.
        The control is a sibling laid over the row's trailing edge instead, and this reserves the
        width so a long title still ellipsises before it reaches the button.
      -->
      {#if canCreate}<span class="add-well"></span>{/if}
    {/snippet}
  </SidebarItem>

  {#if canCreate}
    <span class="add">
      <IconButton
        icon="plus"
        size={22}
        variant="ghost"
        label={t('new_child_page', { title })}
        onclick={() => onCreateChild(node.id)}
      />
    </span>
  {/if}
</div>

{#if isOpen}
  {#each node.children as child (child.id)}
    <PageTreeRow
      node={child}
      depth={depth + 1}
      {activeId}
      {expanded}
      {onToggle}
      {onOpen}
      {onCreateChild}
      {canCreate}
    />
  {/each}
{/if}

<style>
.row {
  position: relative;
}
/*
 * The twisty sits over the item's icon well rather than inside the row, so expanding a page is not
 * the same click target as opening it — a tree where one is inside the other makes it impossible to
 * expand without navigating.
 */
.twisty {
  position: absolute;
  inset-block-start: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: 0;
  background: none;
  padding: 0;
  color: var(--kern-ink-350);
  cursor: pointer;
  border-radius: var(--kern-r-xs);
}
.twisty:hover {
  color: var(--kern-ink-900);
}
.twisty span {
  display: inline-flex;
  transition: transform var(--kern-dur-fast) var(--kern-ease-out);
}
.twisty span.open {
  transform: rotate(90deg);
}
/*
 * A closed chevron points along the reading direction, so it mirrors with the document. An open
 * one points *down*, at the children it revealed — which is the same direction in both, and not
 * something mirroring produces: rotating the other way turned it upside down in Persian.
 */
:global([dir='rtl']) .twisty span {
  transform: scaleX(-1);
}
:global([dir='rtl']) .twisty span.open {
  transform: rotate(90deg);
}
.flag {
  display: inline-flex;
  color: var(--kern-ink-400);
  flex: none;
}
/*
 * Laid over the row's trailing edge rather than inside it, for the reason in the markup above.
 * `opacity: 0` rather than `display: none` is what keeps it focusable, and `:focus-within` on the
 * row is what makes it visible once the keyboard arrives.
 */
.add {
  position: absolute;
  inset-block-start: 50%;
  inset-inline-end: 8px;
  transform: translateY(-50%);
  display: inline-flex;
  opacity: 0;
}
.add-well {
  width: 22px;
  flex: none;
}
.row:hover .add,
.row:focus-within .add {
  opacity: 1;
}
</style>
