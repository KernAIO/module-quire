#!/usr/bin/env node
/**
 * Every `var(--kern-…)` a component references must be a token that exists.
 *
 * A wrong token name is the quietest bug in this repository. Nothing fails — not the build, not
 * `svelte-check`, not a test — the declaration is simply dropped, so a gap becomes 0, a font-size
 * inherits, and muted text renders in the default ink. The whole HR module shipped that way: it was
 * written against a `--kern-space-*` / `--kern-text-*` vocabulary that was never defined, and every
 * one of those rules did nothing on screen.
 *
 * A fallback (`var(--kern-text-faint, #9a9285)`) hides the same mistake behind a value that looks
 * deliberate, so it is reported too — the name is still wrong, and the next person will trust it.
 *
 * A custom property a component defines on itself (`--kern-quire-lane-dir` in `BoardView`) is
 * legitimate: this counts definitions from the component files as well as from the stylesheets.
 *
 * Copied from `shell`, pointed at `src/client`. A module's CSS was checked by nothing until this
 * existed, and this package now carries several hundred lines of it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKEN_STYLES = join(root, 'node_modules/@kernhq/ui/dist/styles')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(svelte|css|ts)$/.test(entry)) out.push(p)
  }
  return out
}

const sources = walk(join(root, 'src', 'client'))
const styleFiles = readdirSync(TOKEN_STYLES)
  .filter((f) => f.endsWith('.css'))
  .map((f) => join(TOKEN_STYLES, f))

/** every `--kern-x: value` declaration, wherever it is declared */
const defined = new Set()
for (const file of [...styleFiles, ...sources]) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/(--kern-[a-z0-9-]+)\s*:/g)) defined.add(m[1])
  // `style:--foo={…}` and `style="--foo:…"` in a Svelte template define one too
  for (const m of text.matchAll(/style:(--kern-[a-z0-9-]+)/g)) defined.add(m[1])
  for (const m of text.matchAll(/style="[^"]*?(--kern-[a-z0-9-]+)\s*:/g)) defined.add(m[1])
}

const problems = []
for (const file of sources) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--kern-[a-z0-9-]+)\s*(,)?/g)) {
      const [, name, hasFallback] = m
      if (defined.has(name)) continue
      problems.push({
        file: file.slice(root.length + 1),
        line: i + 1,
        name,
        note: hasFallback ? ' (a fallback hides it, which is worse)' : '',
      })
    }
  })
}

if (problems.length === 0) {
  console.log(`check-tokens: ${defined.size} tokens defined, every reference resolves`)
  process.exit(0)
}

console.error(`check-tokens: ${problems.length} reference(s) to a token that does not exist\n`)
for (const p of problems) console.error(`  ${p.file}:${p.line}  ${p.name}${p.note}`)
console.error('\nUse a name from @kernhq/ui/styles/tokens.css, or define the property on the component.')
process.exit(1)
