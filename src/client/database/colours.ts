/**
 * The colours a select option may wear.
 *
 * Closed on purpose. `SelectOption.colour` is free text in the contract, so painting it directly
 * means one typo renders a chip with no background — and, worse, a colour pair nobody has measured.
 * Every pair here is one the design tokens already tuned for contrast in light and dark; an unknown
 * name falls back to grey rather than to nothing.
 */
export interface Tone {
  bg: string
  fg: string
}

export const TONES: Record<string, Tone> = {
  grey: { bg: 'var(--kern-surface-chip)', fg: 'var(--kern-ink-550)' },
  slate: { bg: 'var(--kern-slate-tint)', fg: 'var(--kern-slate)' },
  accent: { bg: 'var(--kern-accent-tint)', fg: 'var(--kern-accent-deep)' },
  success: { bg: 'var(--kern-success-tint)', fg: 'var(--kern-success-chip)' },
  warning: { bg: 'var(--kern-warning-tint)', fg: 'var(--kern-warning)' },
  danger: { bg: 'var(--kern-danger-tint)', fg: 'var(--kern-danger)' },
  info: { bg: 'var(--kern-info-tint)', fg: 'var(--kern-info)' },
  purple: { bg: 'var(--kern-purple-tint)', fg: 'var(--kern-purple)' },
}

export const OPTION_COLOURS = Object.keys(TONES)

export const toneFor = (colour: string | undefined | null): Tone => TONES[colour ?? 'grey'] ?? TONES.grey!
