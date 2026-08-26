#!/usr/bin/env node
/**
 * Every locale carries every key, and every counted message carries every plural category.
 *
 * `QuireMessageKey` is `keyof typeof en`, but the other four bundles are plain
 * `Record<string, Message>` — so a key missing from `fa` type-checks perfectly and falls back to
 * English at runtime. With a couple of hundred keys in this file that is the likeliest thing to
 * ship half-done, and nothing else in the repository looks.
 *
 * The plural half matters just as much: `Intl.PluralRules` names six categories for Arabic and two
 * for English, and a variant message missing `many` renders the `other` form for eleven — which is
 * grammatically wrong in a way no English speaker reviewing the diff would notice.
 *
 *   node scripts/check-i18n.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'src/client/i18n.ts')
const source = readFileSync(file, 'utf8')

const LOCALES = ['en', 'ar', 'de', 'fa', 'tr']

/** The body of one `const <locale>: Record<string, Message> = { … }` block. */
function bundle(locale) {
  const start = source.search(new RegExp(`^(?:export )?const ${locale}: Record<string, Message> = \\{$`, 'm'))
  if (start < 0) return null
  const end = source.indexOf('\n}\n', start)
  if (end < 0) return null
  return source.slice(start, end)
}

/**
 * Keys, and the plural forms of the ones written as a variant object.
 *
 * Parsed rather than imported: importing pulls in `@kernhq/ui`, which is Svelte, which plain node
 * cannot load. The file is generated in one shape and this reads that shape.
 */
function parse(body) {
  const keys = new Map()
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = /^ {2}'([a-z0-9_.]+)':\s*(\{)?\s*$|^ {2}'([a-z0-9_.]+)':/.exec(lines[i])
    if (!match) continue
    const key = match[1] ?? match[3]
    if (!key) continue
    if (!lines[i].trimEnd().endsWith('{')) {
      keys.set(key, null)
      continue
    }
    const forms = []
    for (let j = i + 1; j < lines.length && !/^ {2}\},?$/.test(lines[j]); j++) {
      const form = /^ {4}([a-z]+):/.exec(lines[j])
      if (form) forms.push(form[1])
    }
    keys.set(key, forms)
  }
  return keys
}

const bundles = {}
for (const locale of LOCALES) {
  const body = bundle(locale)
  if (!body) {
    console.error(`check-i18n: no \`const ${locale}\` bundle in src/client/i18n.ts`)
    process.exit(1)
  }
  bundles[locale] = parse(body)
}

const problems = []
const reference = bundles.en

if (reference.size < 20) {
  console.error(`check-i18n: only ${reference.size} keys parsed from \`en\` — the file's shape has changed.`)
  process.exit(1)
}

for (const locale of LOCALES) {
  if (locale === 'en') continue
  for (const key of reference.keys())
    if (!bundles[locale].has(key)) problems.push(`${locale}: missing ${key}`)
  for (const key of bundles[locale].keys())
    if (!reference.has(key)) problems.push(`${locale}: ${key} is not in en`)
}

/** The categories this locale actually uses, as the runtime's own `Intl.PluralRules` names them. */
const categoriesFor = (locale) => new Intl.PluralRules(locale).resolvedOptions().pluralCategories

for (const locale of LOCALES) {
  const wanted = categoriesFor(locale)
  for (const [key, forms] of bundles[locale]) {
    const reference_forms = reference.get(key)
    if (reference_forms === undefined) continue
    if (reference_forms === null) {
      if (forms !== null) problems.push(`${locale}: ${key} is counted here and plain in en`)
      continue
    }
    if (forms === null) {
      problems.push(`${locale}: ${key} is counted in en and plain here`)
      continue
    }
    for (const category of wanted)
      if (!forms.includes(category))
        problems.push(`${locale}: ${key} has no \`${category}\` form (${wanted.join(', ')})`)
  }
}

if (problems.length > 0) {
  console.error(`check-i18n: ${problems.length} problem(s) in src/client/i18n.ts\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  console.error('\nEvery locale carries the key set of `en`, and a counted message every category.')
  process.exit(1)
}

console.log(
  `check-i18n: ${reference.size} keys × ${LOCALES.length} locales, every key present and every plural form covered`,
)
