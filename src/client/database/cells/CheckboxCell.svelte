<script lang="ts">
import { Checkbox } from '@kernhq/ui'

/**
 * A checkbox with no visible label, so the column's name is its accessible name — without it a
 * screen reader announces a table of twelve boxes all called "checkbox".
 *
 * An untouched cell is false rather than absent, which is what the server's filter also assumes:
 * "not done" has to include the rows nobody has touched, and that is most of them.
 */
interface Props {
  value: unknown
  name: string
  editable: boolean
  reason?: string
  onchange: (value: unknown) => void
}
const { value, name, editable, reason, onchange }: Props = $props()

const checked = $derived(value === true || value === 'true')
</script>

<span class="wrap" title={editable ? undefined : reason}>
  <Checkbox {checked} disabled={!editable} ariaLabel={name} onCheckedChange={(on) => onchange(on)} />
</span>

<style>
.wrap {
  display: inline-flex;
  align-items: center;
  min-height: 26px;
}
</style>
