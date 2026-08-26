<script lang="ts">
import type { SelectOption } from '../../contract/index.js'
import { toneFor } from './colours.js'

/** One select, status or multi-select value, painted from the closed tone map in `colours.ts`. */
interface Props {
  option?: SelectOption | null
  /** what to draw when the option itself is gone — the raw id is better than an empty cell */
  label?: string
  colour?: string
  compact?: boolean
}
const { option = null, label, colour, compact = false }: Props = $props()

const tone = $derived(toneFor(colour ?? option?.colour))
const text = $derived(label ?? option?.label ?? '')
</script>

<span class="chip" class:compact style:background={tone.bg} style:color={tone.fg}>{text}</span>

<style>
.chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  padding: 3px 9px;
  border-radius: var(--kern-r-md);
  font-size: 12px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip.compact {
  padding: 1px 7px;
  font-size: 11.5px;
}
</style>
