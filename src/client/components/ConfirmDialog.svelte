<script lang="ts">
import { Button, Dialog } from '@kernhq/ui'
import { t } from '../i18n.js'

/**
 * "Are you sure?", said once and properly.
 *
 * Three destructive actions in this module needed the same dialog — moving a page to the trash,
 * emptying one out of it for good, and deleting a label off every page that wears it — and the
 * shape they share is the part worth getting right rather than writing three times:
 *
 * - **The body says what will happen, in numbers.** "Move to trash" fired with no confirmation and
 *   no way back, and it takes the whole subtree: deleting "Working here" silently took "Your first
 *   week" and "Time off" with it. A confirmation that does not say *how many* pages is barely
 *   better than none, so the caller passes a sentence that has already counted them.
 * - **The confirm button is guarded, not disabled.** `busy` reaches the button on the *next*
 *   render, so two quick clicks are one render apart and both get through — the flag is set in the
 *   same tick as the click and read before anything is called. Disabling it would also blur the
 *   control the person is standing on and hand their focus to `<body>`; `aria-busy` says the same
 *   thing to a screen reader without moving anything.
 * - **`pending` holds the same door shut until the sentence is true.** A caller whose body is still
 *   counting passes it, and confirming does nothing until the number arrives. Without it the body
 *   read "Loading…" while the danger button was fully live, so the one dialog whose job is to say
 *   how much goes could be answered before it had said anything at all. It is guarded rather than
 *   disabled for the reason above.
 * - **Cancel is the first thing focus lands on.** `Dialog` focuses the first control in the body
 *   and there is nothing focusable there, so it keeps the close button — which is the safe one.
 */
interface Props {
  open?: boolean
  title: string
  body: string
  /** a second line for what cannot be undone — kept apart so it can be weighted differently */
  note?: string | null
  confirmLabel: string
  danger?: boolean
  /** the body does not know its numbers yet, so nothing may be confirmed against it */
  pending?: boolean
  onConfirm: () => Promise<void> | void
  onCancel?: () => void
}
let {
  open = $bindable(false),
  title,
  body,
  note = null,
  confirmLabel,
  danger = false,
  pending = false,
  onConfirm,
  onCancel,
}: Props = $props()

let busy = $state(false)

async function confirm() {
  if (busy || pending) return
  busy = true
  try {
    await onConfirm()
    open = false
  } finally {
    busy = false
  }
}

function cancel() {
  if (busy) return
  open = false
  onCancel?.()
}
</script>

<Dialog
  bind:open
  {title}
  size="sm"
  onOpenChange={(next) => {
    if (!next) onCancel?.()
  }}
>
  <p class="body">{body}</p>
  {#if note}<p class="note">{note}</p>{/if}

  {#snippet footer()}
    <div class="foot">
      <Button variant="secondary" onclick={cancel}>{t('cancel')}</Button>
      <Button
        variant={danger ? 'danger' : 'primary'}
        aria-busy={busy || pending}
        onclick={() => void confirm()}
      >
        {confirmLabel}
      </Button>
    </div>
  {/snippet}
</Dialog>

<style>
.body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kern-ink-700);
  text-wrap: pretty;
}
/*
 * Muted with a colour, never with `opacity`: fading a paragraph against the page is how a line
 * meant to read as secondary ends up unreadable, whatever its colour token says.
 */
.note {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.55;
  color: var(--kern-ink-450);
  text-wrap: pretty;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
