<script lang="ts">
import type { Label } from '../../contract/index.js'
import { toneFor } from '../database/colours.js'

/**
 * One label, painted.
 *
 * `LabelColour` is a closed enum whose members are exactly the keys of `TONES`, so the lookup can
 * never miss — but it still goes through `toneFor`, which falls back to grey, because the same
 * chips are drawn from data a server sent and a value nobody has seen before should be a grey chip
 * rather than an unpainted one. Every pair in `TONES` is one the design tokens tuned for contrast
 * in both themes, which is the whole reason a label's colour is a menu rather than a text field.
 */
interface Props {
  label: Label
  size?: 'sm' | 'md'
}
const { label, size = 'md' }: Props = $props()
const tone = $derived(toneFor(label.colour))
</script>

<span class="chip" class:sm={size === 'sm'} style:background={tone.bg} style:color={tone.fg}>
  {label.name}
</span>

<style>
.chip {
  display: inline-flex;
  align-items: center;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 9px;
  border-radius: var(--kern-r-md);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.005em;
  line-height: 1.4;
}
.chip.sm {
  padding: 1px 6px;
  font-size: 11px;
  border-radius: var(--kern-r-sm);
}
</style>
