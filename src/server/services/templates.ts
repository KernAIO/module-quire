/**
 * What somebody writes with.
 *
 * A template is a page — or a whole space — saved so it can be made again, with `{{variables}}`
 * filled in at the moment it is made. Three things in this file are worth reading before the code.
 *
 * **The five starters are constants here, not rows in a customer's database.**
 * `migrations/0011_templates.sql` argues that at length; what it means for this file is that
 * `STARTERS` below is the only copy of them, that a workspace edits one by writing a row carrying
 * its `key` — which then *replaces* it in the picker rather than sitting beside it — and that
 * deleting that row brings the shipped one back, current and translated.
 *
 * **Their strings are a table in this file, resolved against `principal.locale`.** That is a second
 * message catalogue in a module that already has one, and it is deliberate: `src/client/i18n.ts`
 * reaches `t()` through `@kernhq/ui`, which is Svelte, which this process has never loaded and must
 * not. A starter's prose has to exist on the server — `instantiate` is a procedure, not a screen —
 * so the choice is between a table here and a starter that is English in an Arabic workspace for
 * ever. TypeScript holds the four translations to `en`'s key set, which is the same guarantee
 * `scripts/check-i18n.mjs` gives the client bundle.
 *
 * **Substitution walks the document and replaces in text nodes. It never touches JSON.** Building a
 * page by `JSON.stringify` → `String.replace` → `JSON.parse` is the obvious shortcut and it is
 * broken twice over: a value containing `"` ends the string it was pasted into, and a value
 * containing `{{` or `$&` is re-read as syntax. `fillNode` below clones the tree and replaces inside
 * `text` only, with a *function* replacement so `$&` and `$1` in somebody's answer are characters
 * rather than back-references. `templates.int.test.ts` fills a variable with a quote, a brace pair,
 * a newline and an emoji at once and asserts all four survive.
 */
import type { Principal } from '@kernhq/contracts'
import { KernError, type Kernel, type Tx, uuidv7 } from '@kernhq/kernel'
import type { PageDoc, PageDocNode } from '@kernhq/ui/editor/page-doc'
import { and, asc, eq, isNull, or } from 'drizzle-orm'
import type {
  Template,
  TemplateChoice,
  TemplateKind,
  TemplateResult,
  TemplateSpaceNode,
  TemplateStarterKey,
  TemplateVariable,
} from '../../contract/index.js'
import { TEMPLATE_STARTER_KEYS, TemplateSpaceBody } from '../../contract/index.js'
import { pageDocFromBase64, pageDocFromState } from '../document.js'
import { pageDocToYState } from '../import/ydoc.js'
import { textFromPageDoc } from '../render.js'
import { pages, pageVersions, templates } from '../schema.js'
import type { QuireAccess } from './access.js'
import type { QuirePages } from './pages.js'
import { documentNameOf } from './pages.js'
import type { QuireSpaces } from './spaces.js'

type TemplateRow = typeof templates.$inferSelect

/**
 * How deep `fillNode` will descend, and how many pages a space template may hold.
 *
 * The depth cap is not decoration. `doc` is a JSONB column, so what comes back is whatever was
 * written there — and a recursive walk over an adversarially nested document is a stack overflow,
 * which in Node is a process, not an exception. The page cap is the same argument at the other end:
 * a space template that made four thousand pages in one request would be an outage wearing a
 * feature's clothes.
 */
const MAX_DOC_DEPTH = 64
const MAX_TEMPLATE_PAGES = 200

// =====================================================================================
// The five starters
// =====================================================================================

/**
 * The starters' own words, in every locale the platform ships.
 *
 * `en` is the reference and the other four are typed against its keys, so a missing translation is
 * a compile error rather than an English heading in an Arabic page. The strings are deliberately
 * plain — a starter is scaffolding somebody writes over, and prompts they have to delete are worse
 * than headings they can type under.
 */
const en = {
  'meeting-notes.name': 'Meeting notes',
  'meeting-notes.description': 'Who was there, what was decided, and who does what next.',
  'meeting-notes.attendees': 'Attendees',
  'meeting-notes.agenda': 'Agenda',
  'meeting-notes.notes': 'Notes',
  'meeting-notes.decisions': 'Decisions',
  'meeting-notes.actions': 'Actions',

  'decision-record.name': 'Decision record',
  'decision-record.description': 'One decision, why it was taken, and what it commits you to.',
  'decision-record.status': 'Status',
  'decision-record.status_value': 'Proposed',
  'decision-record.context': 'Context',
  'decision-record.decision': 'Decision',
  'decision-record.consequences': 'Consequences',
  'decision-record.alternatives': 'Alternatives considered',

  'requirements.name': 'Requirements',
  'requirements.description': 'What a piece of work has to do, and what it deliberately does not.',
  'requirements.summary': 'Summary',
  'requirements.goals': 'Goals',
  'requirements.out_of_scope': 'Out of scope',
  'requirements.requirements': 'Requirements',
  'requirements.questions': 'Open questions',

  'retrospective.name': 'Retrospective',
  'retrospective.description': 'What went well, what got in the way, and what to change.',
  'retrospective.well': 'What went well',
  'retrospective.blocked': 'What got in the way',
  'retrospective.try': 'What we will try',
  'retrospective.actions': 'Actions',

  'how-to.name': 'How-to',
  'how-to.description': 'A task somebody can follow from start to finish.',
  'how-to.before': 'Before you start',
  'how-to.steps': 'Steps',
  'how-to.check': 'Check it worked',
  'how-to.trouble': 'If something goes wrong',
} as const

type StarterStringKey = keyof typeof en
type StarterStrings = Record<StarterStringKey, string>

const ar: StarterStrings = {
  'meeting-notes.name': 'محضر اجتماع',
  'meeting-notes.description': 'من حضر، وما الذي تقرّر، ومن يفعل ماذا بعد ذلك.',
  'meeting-notes.attendees': 'الحاضرون',
  'meeting-notes.agenda': 'جدول الأعمال',
  'meeting-notes.notes': 'الملاحظات',
  'meeting-notes.decisions': 'القرارات',
  'meeting-notes.actions': 'الإجراءات',

  'decision-record.name': 'سجل قرار',
  'decision-record.description': 'قرار واحد، ولماذا اتُّخذ، وما الذي يلزمك به.',
  'decision-record.status': 'الحالة',
  'decision-record.status_value': 'مقترح',
  'decision-record.context': 'السياق',
  'decision-record.decision': 'القرار',
  'decision-record.consequences': 'النتائج',
  'decision-record.alternatives': 'البدائل التي نُظر فيها',

  'requirements.name': 'المتطلبات',
  'requirements.description': 'ما يجب أن ينجزه العمل، وما لا ينجزه عن قصد.',
  'requirements.summary': 'الملخص',
  'requirements.goals': 'الأهداف',
  'requirements.out_of_scope': 'خارج النطاق',
  'requirements.requirements': 'المتطلبات',
  'requirements.questions': 'أسئلة مفتوحة',

  'retrospective.name': 'مراجعة استعادية',
  'retrospective.description': 'ما سار جيدًا، وما أعاق العمل، وما الذي نغيّره.',
  'retrospective.well': 'ما سار جيدًا',
  'retrospective.blocked': 'ما أعاق العمل',
  'retrospective.try': 'ما سنجرّبه',
  'retrospective.actions': 'الإجراءات',

  'how-to.name': 'دليل عملي',
  'how-to.description': 'مهمة يمكن لأي شخص تنفيذها من أولها إلى آخرها.',
  'how-to.before': 'قبل أن تبدأ',
  'how-to.steps': 'الخطوات',
  'how-to.check': 'تأكّد من نجاحها',
  'how-to.trouble': 'إذا حدث خطأ',
}

const de: StarterStrings = {
  'meeting-notes.name': 'Besprechungsnotizen',
  'meeting-notes.description': 'Wer da war, was entschieden wurde und wer als Nächstes was tut.',
  'meeting-notes.attendees': 'Teilnehmende',
  'meeting-notes.agenda': 'Tagesordnung',
  'meeting-notes.notes': 'Notizen',
  'meeting-notes.decisions': 'Entscheidungen',
  'meeting-notes.actions': 'Aufgaben',

  'decision-record.name': 'Entscheidungsprotokoll',
  'decision-record.description': 'Eine Entscheidung, warum sie getroffen wurde und wozu sie verpflichtet.',
  'decision-record.status': 'Status',
  'decision-record.status_value': 'Vorgeschlagen',
  'decision-record.context': 'Kontext',
  'decision-record.decision': 'Entscheidung',
  'decision-record.consequences': 'Folgen',
  'decision-record.alternatives': 'Geprüfte Alternativen',

  'requirements.name': 'Anforderungen',
  'requirements.description': 'Was eine Arbeit leisten muss – und was bewusst nicht.',
  'requirements.summary': 'Zusammenfassung',
  'requirements.goals': 'Ziele',
  'requirements.out_of_scope': 'Nicht im Umfang',
  'requirements.requirements': 'Anforderungen',
  'requirements.questions': 'Offene Fragen',

  'retrospective.name': 'Retrospektive',
  'retrospective.description': 'Was gut lief, was im Weg stand und was sich ändern soll.',
  'retrospective.well': 'Was gut lief',
  'retrospective.blocked': 'Was im Weg stand',
  'retrospective.try': 'Was wir ausprobieren',
  'retrospective.actions': 'Aufgaben',

  'how-to.name': 'Anleitung',
  'how-to.description': 'Eine Aufgabe, die jemand von Anfang bis Ende durchführen kann.',
  'how-to.before': 'Bevor Sie beginnen',
  'how-to.steps': 'Schritte',
  'how-to.check': 'Ergebnis prüfen',
  'how-to.trouble': 'Wenn etwas schiefgeht',
}

const fa: StarterStrings = {
  'meeting-notes.name': 'یادداشت جلسه',
  'meeting-notes.description': 'چه کسانی بودند، چه تصمیمی گرفته شد و بعد چه کسی چه می‌کند.',
  'meeting-notes.attendees': 'حاضران',
  'meeting-notes.agenda': 'دستور جلسه',
  'meeting-notes.notes': 'یادداشت‌ها',
  'meeting-notes.decisions': 'تصمیم‌ها',
  'meeting-notes.actions': 'کارها',

  'decision-record.name': 'سند تصمیم',
  'decision-record.description': 'یک تصمیم، دلیل گرفتن آن، و آنچه شما را به آن متعهد می‌کند.',
  'decision-record.status': 'وضعیت',
  'decision-record.status_value': 'پیشنهادی',
  'decision-record.context': 'زمینه',
  'decision-record.decision': 'تصمیم',
  'decision-record.consequences': 'پیامدها',
  'decision-record.alternatives': 'گزینه‌های بررسی‌شده',

  'requirements.name': 'نیازمندی‌ها',
  'requirements.description': 'کاری که باید انجام شود، و آنچه عمداً انجام نمی‌شود.',
  'requirements.summary': 'خلاصه',
  'requirements.goals': 'هدف‌ها',
  'requirements.out_of_scope': 'خارج از دامنه',
  'requirements.requirements': 'نیازمندی‌ها',
  'requirements.questions': 'پرسش‌های باز',

  'retrospective.name': 'بازنگری',
  'retrospective.description': 'چه چیزی خوب پیش رفت، چه چیزی مانع شد و چه چیزی را تغییر می‌دهیم.',
  'retrospective.well': 'چه چیزی خوب پیش رفت',
  'retrospective.blocked': 'چه چیزی مانع شد',
  'retrospective.try': 'چه چیزی را می‌آزماییم',
  'retrospective.actions': 'کارها',

  'how-to.name': 'راهنمای گام‌به‌گام',
  'how-to.description': 'کاری که هر کس بتواند از آغاز تا پایان دنبالش کند.',
  'how-to.before': 'پیش از شروع',
  'how-to.steps': 'گام‌ها',
  'how-to.check': 'درستی کار را بررسی کنید',
  'how-to.trouble': 'اگر چیزی اشتباه پیش رفت',
}

const tr: StarterStrings = {
  'meeting-notes.name': 'Toplantı notları',
  'meeting-notes.description': 'Kimler vardı, ne karara bağlandı ve sırada kim ne yapıyor.',
  'meeting-notes.attendees': 'Katılanlar',
  'meeting-notes.agenda': 'Gündem',
  'meeting-notes.notes': 'Notlar',
  'meeting-notes.decisions': 'Kararlar',
  'meeting-notes.actions': 'İşler',

  'decision-record.name': 'Karar kaydı',
  'decision-record.description': 'Tek bir karar, neden alındığı ve neye bağladığı.',
  'decision-record.status': 'Durum',
  'decision-record.status_value': 'Önerildi',
  'decision-record.context': 'Bağlam',
  'decision-record.decision': 'Karar',
  'decision-record.consequences': 'Sonuçlar',
  'decision-record.alternatives': 'Değerlendirilen seçenekler',

  'requirements.name': 'Gereksinimler',
  'requirements.description': 'Bir işin yapması gerekenler ve bilerek yapmadıkları.',
  'requirements.summary': 'Özet',
  'requirements.goals': 'Hedefler',
  'requirements.out_of_scope': 'Kapsam dışı',
  'requirements.requirements': 'Gereksinimler',
  'requirements.questions': 'Açık sorular',

  'retrospective.name': 'Retrospektif',
  'retrospective.description': 'Ne iyi gitti, ne engel oldu ve neyi değiştireceğiz.',
  'retrospective.well': 'Ne iyi gitti',
  'retrospective.blocked': 'Ne engel oldu',
  'retrospective.try': 'Ne deneyeceğiz',
  'retrospective.actions': 'İşler',

  'how-to.name': 'Nasıl yapılır',
  'how-to.description': 'Birinin baştan sona izleyebileceği bir iş.',
  'how-to.before': 'Başlamadan önce',
  'how-to.steps': 'Adımlar',
  'how-to.check': 'Çalıştığını doğrulayın',
  'how-to.trouble': 'Bir şey ters giderse',
}

const STARTER_TEXT: Record<string, StarterStrings> = { ar, de, en, fa, tr }

/**
 * The reader's own language, or English.
 *
 * `principal.locale` is whatever core stored, which may be a region tag (`en-GB`, `pt-BR`), so the
 * base subtag is what is looked up. A locale this module has no table for falls back rather than
 * throwing: a page in the wrong language is a disappointment, and a 500 when somebody presses "New
 * page" is a broken product.
 */
function stringsFor(locale: string | null | undefined): StarterStrings {
  const base = (locale ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en'
  return STARTER_TEXT[base] ?? en
}

/** A paragraph, empty when there is nothing to put in it — an empty one is a line to type on. */
const p = (text?: string): PageDocNode =>
  text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' }

const h = (text: string): PageDocNode => ({
  type: 'heading',
  attrs: { level: 2 },
  content: [{ type: 'text', text }],
})

const bullets = (): PageDocNode => ({
  type: 'bulletList',
  content: [{ type: 'listItem', content: [p()] }],
})

const numbered = (): PageDocNode => ({
  type: 'orderedList',
  content: [{ type: 'listItem', content: [p()] }],
})

const tasks = (): PageDocNode => ({
  type: 'taskList',
  content: [{ type: 'taskItem', attrs: { checked: false }, content: [p()] }],
})

/**
 * The line every starter opens with.
 *
 * `{{date}}` and `{{author}}` are the two built-ins the plan names, and putting them at the top of
 * all five is what makes the feature legible: somebody who has never read this file sees the braces
 * become a date the first time they make a page, and now knows what a variable is.
 */
const byline = (): PageDocNode => p('{{date}} · {{author}}')

/**
 * Every node in these bodies is one `renderPageDoc` draws and `buildPageExtensions` produces.
 *
 * That is the editor-schema rule, and a template is where breaking it costs most: a starter using a
 * node the renderer has no case for would export blank, publish blank and print blank, for every
 * page anybody ever made from it. Nothing checks it here — `render.test.ts` checks the renderer
 * against the schema, and these use only paragraph, heading, bulletList, orderedList, listItem,
 * taskList, taskItem and text.
 *
 * **None of them declares a variable, and that is a decision rather than an omission.** A declared
 * variable has a `label` and, for a `select`, a list of `options` — an author's own words, in the
 * author's own language. A shipped starter has no author, so every one of those strings would have
 * to join the table above and be translated five ways to ask somebody for a sprint number. The two
 * built-ins are filled from the request and need no words at all, which is why a starter can use
 * them and nothing else.
 */
const STARTERS: Record<TemplateStarterKey, { icon: string; body: (s: StarterStrings) => PageDocNode[] }> = {
  'meeting-notes': {
    icon: 'users',
    body: (s) => [
      byline(),
      h(s['meeting-notes.attendees']),
      bullets(),
      h(s['meeting-notes.agenda']),
      bullets(),
      h(s['meeting-notes.notes']),
      p(),
      h(s['meeting-notes.decisions']),
      bullets(),
      h(s['meeting-notes.actions']),
      tasks(),
    ],
  },
  'decision-record': {
    icon: 'flag',
    body: (s) => [
      byline(),
      h(s['decision-record.status']),
      p(s['decision-record.status_value']),
      h(s['decision-record.context']),
      p(),
      h(s['decision-record.decision']),
      p(),
      h(s['decision-record.consequences']),
      p(),
      h(s['decision-record.alternatives']),
      bullets(),
    ],
  },
  requirements: {
    icon: 'target',
    body: (s) => [
      byline(),
      h(s['requirements.summary']),
      p(),
      h(s['requirements.goals']),
      bullets(),
      h(s['requirements.out_of_scope']),
      bullets(),
      h(s['requirements.requirements']),
      tasks(),
      h(s['requirements.questions']),
      bullets(),
    ],
  },
  retrospective: {
    icon: 'refresh-cw',
    body: (s) => [
      byline(),
      h(s['retrospective.well']),
      bullets(),
      h(s['retrospective.blocked']),
      bullets(),
      h(s['retrospective.try']),
      bullets(),
      h(s['retrospective.actions']),
      tasks(),
    ],
  },
  'how-to': {
    icon: 'wrench',
    body: (s) => [
      byline(),
      h(s['how-to.before']),
      bullets(),
      h(s['how-to.steps']),
      numbered(),
      h(s['how-to.check']),
      p(),
      h(s['how-to.trouble']),
      p(),
    ],
  },
}

/** A starter as the picker draws it, in one language. */
function starterChoice(key: TemplateStarterKey, s: StarterStrings): TemplateChoice {
  return {
    id: null,
    key,
    builtIn: true,
    kind: 'page',
    spaceId: null,
    name: s[`${key}.name` as StarterStringKey],
    description: s[`${key}.description` as StarterStringKey],
    icon: STARTERS[key].icon,
    variables: [],
    updatedAt: null,
  }
}

/** A starter's body, built fresh every time — the constants above are shared and never mutated. */
function starterDoc(key: TemplateStarterKey, s: StarterStrings): PageDoc {
  return { type: 'doc', content: STARTERS[key].body(s) }
}

// =====================================================================================
// Variables
// =====================================================================================

/**
 * What a placeholder looks like: `{{name}}`, with optional spaces inside the braces.
 *
 * The name is the same grammar `TemplateVariableName` enforces — lowercase, digits, underscores —
 * so a template cannot declare a name this pattern would not find, and nothing else in a page can
 * accidentally look like one.
 */
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g

/**
 * Replace the placeholders in one string.
 *
 * The replacement is a **function**, which is the whole point. `String.replace` with a string
 * replacement reads `$&`, `$1` and `$'` in the *replacement* as back-references, so somebody
 * answering a template's question with `$&` would get their own placeholder back, and `$'` would
 * paste the rest of the paragraph. A function is handed the match and its return value is used
 * verbatim.
 *
 * An unknown name is left exactly as it was written rather than removed. A template one release
 * ahead of its server, or a body somebody typed braces into by hand, should show a placeholder the
 * author can see and fix — deleting text somebody wrote is the worse of the two failures.
 *
 * The scan is single-pass, so a value containing `{{other}}` is characters and not a second
 * substitution: `replace` never re-reads what it has written.
 */
function fillText(text: string, values: Map<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => values.get(name) ?? whole)
}

/**
 * The same document with its text filled in — a **copy**, never the original.
 *
 * Cloning matters for two different reasons at once. The starter bodies are module-level constants
 * shared by every request in the process, so filling one in place would leak one workspace's answers
 * into the next workspace's page. And a stored `doc` is JSONB the caller may hold a reference to.
 *
 * Attributes are copied and never substituted. A `{{…}}` inside a link's `href` or an image's
 * `fileId` is not prose, and filling it would let a template's answer decide where a link points —
 * which is a template author writing a URL somebody else's answer completes.
 */
function fillNode(node: PageDocNode, values: Map<string, string>, depth: number): PageDocNode {
  const out: PageDocNode = {}
  if (typeof node.type === 'string') out.type = node.type
  if (typeof node.text === 'string') out.text = fillText(node.text, values)
  if (node.attrs && typeof node.attrs === 'object') out.attrs = { ...node.attrs }
  if (Array.isArray(node.marks)) out.marks = node.marks.map((mark) => ({ ...mark }))
  if (Array.isArray(node.content) && depth < MAX_DOC_DEPTH)
    out.content = node.content
      .filter((child): child is PageDocNode => typeof child === 'object' && child !== null)
      .map((child) => fillNode(child, values, depth + 1))
  return out
}

/** A whole document with its text filled in. An empty or malformed one stays empty. */
export function fillPageDoc(doc: PageDoc | null | undefined, values: Map<string, string>): PageDoc {
  if (!doc || !Array.isArray(doc.content)) return { type: 'doc', content: [] }
  return {
    type: 'doc',
    content: doc.content
      .filter((node): node is PageDocNode => typeof node === 'object' && node !== null)
      .map((node) => fillNode(node, values, 1)),
  }
}

/**
 * Everything a placeholder may become: what the module fills, then what somebody typed.
 *
 * The built-ins go in first and the answers second, which is the wrong order for precedence and the
 * right one here: `TemplateVariableName` refuses the reserved names outright, so nothing a template
 * declares can collide with one and the ordering never decides anything. It is written this way so
 * that if that refusal is ever relaxed, an author's own variable wins over ours rather than being
 * silently overwritten by it.
 *
 * `{{workspace}}` is reserved and **not filled**. Reserving it is what keeps adding it later a
 * non-breaking change — an author who had taken the name would otherwise find their template
 * quietly rendering something else — and filling it needs a workspace name this module would have
 * to ask core for on every instantiation. Until something needs it, an unfilled reserved name
 * behaves exactly as an unknown one: it stays on the page, visible.
 */
function valuesFor(
  principal: Principal,
  locale: string | null | undefined,
  spaceName: string,
  declared: TemplateVariable[],
  supplied: Record<string, string>,
): Map<string, string> {
  const now = new Date()
  const values = new Map<string, string>()
  // Through Intl, so a Persian workspace gets Persian digits and an Arabic one an Arabic calendar
  // — the same rule every number and date in Kern follows.
  const tag = locale || 'en'
  values.set('date', new Intl.DateTimeFormat(tag, { dateStyle: 'long' }).format(now))
  values.set('time', new Intl.DateTimeFormat(tag, { timeStyle: 'short' }).format(now))
  values.set('author', principal.name || principal.email || '')
  values.set('space', spaceName)

  for (const variable of declared) {
    const given = supplied[variable.name]
    const value = given === undefined || given === '' ? (variable.default ?? '') : given
    if (variable.required && value === '')
      throw KernError.badRequest(`"${variable.label}" is needed before this can be made`)
    values.set(variable.name, value)
  }
  return values
}

/**
 * Whether this failure is that named constraint, **looked for in `cause` and not in the message**.
 *
 * Drizzle wraps every failed statement in a `DrizzleQueryError` whose text is the SQL and its
 * parameters; the Postgres error — with its `23505` and the name of the index it violated — is one
 * link down the `cause` chain. A `String(err).includes('…_uq')` therefore never matches, silently,
 * and the friendly conflict it was meant to raise turns into a raw driver error with the whole
 * statement in it. That is what this shipped as until the test asked for the conflict by name.
 */
function violates(err: unknown, constraint: string): boolean {
  let at: unknown = err
  for (let depth = 0; at && depth < 6; depth += 1) {
    const candidate = at as { code?: string; constraint?: string; message?: string; cause?: unknown }
    if (
      candidate.code === '23505' &&
      (candidate.constraint === constraint || (candidate.message ?? '').includes(constraint))
    )
      return true
    at = candidate.cause
  }
  return false
}

/** Two variables of the same name is a form with two fields writing to one placeholder. */
function checkVariables(variables: TemplateVariable[]): void {
  const seen = new Set<string>()
  for (const variable of variables) {
    if (seen.has(variable.name))
      throw KernError.badRequest(`Two of these fields are called "${variable.name}"`)
    seen.add(variable.name)
    if (variable.type === 'select' && variable.options.length === 0)
      throw KernError.badRequest(`"${variable.label}" is a list with nothing in it`)
  }
}

// =====================================================================================
// The service
// =====================================================================================

export function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    workspaceId: row.workspaceId as Template['workspaceId'],
    spaceId: row.spaceId,
    kind: row.kind as TemplateKind,
    key: row.key,
    builtIn: row.builtIn,
    name: row.name,
    description: row.description,
    icon: row.icon,
    doc: (row.doc ?? {}) as Template['doc'],
    variables: (row.variables ?? []) as TemplateVariable[],
    createdBy: row.createdBy as Template['createdBy'],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

const toChoice = (row: TemplateRow): TemplateChoice => ({
  id: row.id,
  key: row.key,
  builtIn: row.builtIn,
  kind: row.kind as TemplateKind,
  spaceId: row.spaceId,
  name: row.name,
  description: row.description,
  icon: row.icon,
  variables: (row.variables ?? []) as TemplateVariable[],
  updatedAt: row.updatedAt.toISOString(),
})

export function quireTemplates(
  kernel: Kernel,
  access: QuireAccess,
  pagesSvc: QuirePages,
  spacesSvc: QuireSpaces,
) {
  /**
   * A page's prose, as a document.
   *
   * The live collaborative document first, because that is what the person looking at the page can
   * see — saving a template from a page and getting last week's published copy would be baffling.
   * The newest stored version is the fallback, for a page whose document the collab service has
   * forgotten or has never held.
   */
  async function docOfPage(tx: Tx, workspaceId: string, pageId: string): Promise<PageDoc | null> {
    const live = await kernel
      .call<{ state: string | null }>('collab.document.state', {
        name: documentNameOf({ workspaceId, id: pageId }),
      })
      .catch(() => null)
    const fromLive = pageDocFromBase64(live?.state ?? null)
    if (fromLive) return fromLive

    const [version] = await tx
      .select({ state: pageVersions.state })
      .from(pageVersions)
      .where(and(eq(pageVersions.workspaceId, workspaceId), eq(pageVersions.pageId, pageId)))
      .orderBy(asc(pageVersions.id))
      .limit(1)
    return version ? pageDocFromState(version.state) : null
  }

  /**
   * The space's tree as a template body — only the pages this person may read.
   *
   * That filter is the whole security question this procedure has. A space template copies other
   * people's prose into something anybody who may create a page can then read, so a page a
   * page-scoped DENY has closed to the author must not travel into it. A skipped page takes its
   * descendants with it: a child whose parent was left out has nowhere to hang, and lifting it to
   * the top would put a restricted page's child in the template anyway.
   *
   * Rows of a database are excluded for the same reason `pages.tree` excludes them — five hundred
   * rows under one node is not a template, it is a copy of a database without its columns.
   */
  async function treeOfSpace(
    tx: Tx,
    principal: Principal,
    workspaceId: string,
    spaceId: string,
  ): Promise<TemplateSpaceNode[]> {
    const rows = await tx
      .select({
        id: pages.id,
        parentId: pages.parentId,
        title: pages.title,
        icon: pages.icon,
      })
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspaceId),
          eq(pages.spaceId, spaceId),
          isNull(pages.deletedAt),
          isNull(pages.archivedAt),
          isNull(pages.databaseId),
        ),
      )
      .orderBy(asc(pages.position))
    if (rows.length > MAX_TEMPLATE_PAGES)
      throw KernError.badRequest(
        `A space template holds at most ${MAX_TEMPLATE_PAGES} pages, and this space has ${rows.length}`,
      )

    const parentOf = new Map(rows.map((row) => [row.id, row.parentId]))
    const ancestorsOf = (id: string): string[] => {
      const chain: string[] = []
      const seen = new Set([id])
      let at = parentOf.get(id) ?? null
      while (at !== null && !seen.has(at)) {
        chain.push(at)
        seen.add(at)
        at = parentOf.get(at) ?? null
      }
      return chain
    }

    const readable = new Set<string>()
    for (const row of rows)
      if (
        await access.canPage(principal, 'quire.page.view', workspaceId, {
          pageId: row.id,
          spaceId,
          ancestorIds: ancestorsOf(row.id),
        })
      )
        readable.add(row.id)

    const build = async (parentId: string | null, depth: number): Promise<TemplateSpaceNode[]> => {
      if (depth > 16) return []
      const out: TemplateSpaceNode[] = []
      for (const row of rows) {
        if (row.parentId !== parentId) continue
        // A page the author may not read is left out, and so is everything under it.
        if (!readable.has(row.id)) continue
        out.push({
          title: row.title,
          icon: row.icon,
          doc: ((await docOfPage(tx, workspaceId, row.id)) ?? { type: 'doc', content: [] }) as Record<
            string,
            unknown
          >,
          children: await build(row.id, depth + 1),
        })
      }
      return out
    }
    return build(null, 0)
  }

  /** Write a document into a page that has just been made, and mirror its text for search. */
  async function writeBody(tx: Tx, workspaceId: string, pageId: string, doc: PageDoc): Promise<void> {
    if ((doc.content ?? []).length === 0) return
    const state = pageDocToYState(doc)
    await kernel.call('collab.document.replace', {
      name: documentNameOf({ workspaceId, id: pageId }),
      state: state.toString('base64'),
    })
    /*
     * The mirrored column, so a page made from a template is findable before anybody edits it.
     *
     * No version row is written, deliberately. `VersionKind` has `auto`, `publish`, `restore` and
     * `import`, and none of them is what this is — labelling it `import` would put "Imported" in a
     * history the reader is meant to trust. The first version is taken the first time somebody
     * writes in the page, which is the same moment it would be for a blank one.
     */
    await tx
      .update(pages)
      .set({ text: textFromPageDoc(doc) })
      .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
  }

  return {
    /** The row, for a caller that needs its scope before deciding anything. */
    async row(tx: Tx, workspaceId: string, templateId: string): Promise<TemplateRow> {
      const [row] = await tx
        .select()
        .from(templates)
        .where(and(eq(templates.workspaceId, workspaceId), eq(templates.id, templateId)))
        .limit(1)
      if (!row) throw KernError.notFound('Template')
      return row
    },

    /**
     * What may be made here: the starters, plus this workspace's own.
     *
     * The override is applied by key: a row carrying `retrospective` takes the shipped
     * retrospective's place in the list rather than appearing after it. That is what makes the
     * copy-on-write story visible — a workspace that has edited one starter sees five entries, not
     * six — and it is why the partial-unique index on `(workspace_id, key)` exists.
     *
     * Starters are page templates, so `kind: 'space'` answers rows only. That is not a gap: a space
     * template is a shape of somebody's own organisation, and there is no such thing as a generic
     * one worth shipping.
     */
    async list(
      tx: Tx,
      workspaceId: string,
      kind: TemplateKind,
      spaceId: string | null,
      locale: string | null | undefined,
    ): Promise<TemplateChoice[]> {
      const rows = await tx
        .select()
        .from(templates)
        .where(
          and(
            eq(templates.workspaceId, workspaceId),
            eq(templates.kind, kind),
            // Workspace-wide always, plus this space's own when a space was named.
            spaceId
              ? or(isNull(templates.spaceId), eq(templates.spaceId, spaceId))
              : isNull(templates.spaceId),
          ),
        )
        .orderBy(asc(templates.name))

      const byKey = new Map(rows.filter((row) => row.key !== null).map((row) => [row.key as string, row]))
      const out: TemplateChoice[] = []
      if (kind === 'page') {
        const s = stringsFor(locale)
        for (const key of TEMPLATE_STARTER_KEYS) {
          const override = byKey.get(key)
          out.push(override ? toChoice(override) : starterChoice(key, s))
        }
      }
      // Everything else, in name order. A row whose key names a starter this release no longer
      // ships is an ordinary template and lands here, which is the read side of the rule that
      // `Template.key` is a string rather than the enum.
      for (const row of rows)
        if (row.key === null || !(TEMPLATE_STARTER_KEYS as readonly string[]).includes(row.key))
          out.push(toChoice(row))
      return out
    },

    async get(tx: Tx, workspaceId: string, templateId: string): Promise<Template> {
      return toTemplate(await this.row(tx, workspaceId, templateId))
    },

    /**
     * Save a page — or a space's whole tree — as a template.
     *
     * The body is read here rather than taken from the caller, and that is the point of the
     * procedure: a client that could post a document would make "save as template" a way to write
     * arbitrary prose into something everybody in the space is then offered.
     */
    async createFromPage(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      input: {
        kind: TemplateKind
        sourceId: string
        spaceId: string | null
        name: string
        description: string
        icon: string | null
        variables: TemplateVariable[]
        key: TemplateStarterKey | null
      },
    ): Promise<Template> {
      checkVariables(input.variables)
      // The check constraint holds the pair, but a 23514 reaching a person as "violates constraint
      // templates_key_matches_built_in" is not an error anybody can act on.
      if (input.kind === 'space' && input.spaceId !== null)
        throw KernError.badRequest('A space template makes a space, so it cannot live inside one')

      const doc = await this.bodyFor(tx, principal, workspaceId, input.kind, input.sourceId)
      const [row] = await tx
        .insert(templates)
        .values({
          id: uuidv7(),
          workspaceId,
          spaceId: input.spaceId,
          kind: input.kind,
          key: input.key,
          builtIn: input.key !== null,
          name: input.name,
          description: input.description,
          icon: input.icon,
          doc,
          variables: input.variables,
          createdBy: principal.userId,
        })
        .returning()
        .catch((err: unknown) => {
          // The partial-unique index on `(workspace_id, key)`: one override per starter.
          if (violates(err, 'templates_ws_key_uq'))
            throw KernError.conflict('This workspace already has its own version of that template')
          throw err
        })
      return toTemplate(row!)
    },

    /** The body a template of this kind takes from this source, checked and read. */
    async bodyFor(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      kind: TemplateKind,
      sourceId: string,
    ): Promise<Record<string, unknown>> {
      if (kind === 'space') {
        await access.spaceRow(tx, workspaceId, sourceId)
        return { pages: await treeOfSpace(tx, principal, workspaceId, sourceId) }
      }
      const doc = await docOfPage(tx, workspaceId, sourceId)
      if (!doc || (doc.content ?? []).length === 0)
        throw KernError.badRequest('There is nothing written on this page to make a template from')
      return doc as Record<string, unknown>
    },

    async update(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      templateId: string,
      patch: {
        name?: string
        description?: string
        icon?: string | null
        spaceId?: string | null
        variables?: TemplateVariable[]
        sourceId?: string
      },
    ): Promise<Template> {
      const existing = await this.row(tx, workspaceId, templateId)
      if (patch.variables) checkVariables(patch.variables)
      if (patch.spaceId !== undefined && existing.kind === 'space' && patch.spaceId !== null)
        throw KernError.badRequest('A space template makes a space, so it cannot live inside one')

      const doc =
        patch.sourceId === undefined
          ? undefined
          : await this.bodyFor(tx, principal, workspaceId, existing.kind as TemplateKind, patch.sourceId)

      const [row] = await tx
        .update(templates)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.icon === undefined ? {} : { icon: patch.icon }),
          ...(patch.spaceId === undefined ? {} : { spaceId: patch.spaceId }),
          ...(patch.variables === undefined ? {} : { variables: patch.variables }),
          ...(doc === undefined ? {} : { doc }),
          updatedAt: new Date(),
        })
        .where(and(eq(templates.workspaceId, workspaceId), eq(templates.id, templateId)))
        .returning()
      if (!row) throw KernError.notFound('Template')
      return toTemplate(row)
    },

    /** Gone. For a row that replaced a starter, the shipped one is back the moment this returns. */
    async remove(tx: Tx, workspaceId: string, templateId: string): Promise<void> {
      const deleted = await tx
        .delete(templates)
        .where(and(eq(templates.workspaceId, workspaceId), eq(templates.id, templateId)))
        .returning({ id: templates.id })
      if (deleted.length === 0) throw KernError.notFound('Template')
    },

    /**
     * What `instantiate` is about to make, whichever of the two ways it was addressed.
     *
     * Resolved in one place so the handler never has to hold "a row or a starter" in its head, and
     * so the refusal for "both" and "neither" is written once.
     */
    async resolve(
      tx: Tx,
      workspaceId: string,
      locale: string | null | undefined,
      templateId: string | null,
      starterKey: TemplateStarterKey | null,
    ): Promise<{ kind: TemplateKind; name: string; doc: PageDoc; variables: TemplateVariable[] }> {
      if ((templateId === null) === (starterKey === null))
        throw KernError.badRequest('Name a template or a starter, and not both')
      if (starterKey !== null) {
        const s = stringsFor(locale)
        /*
         * A workspace that has edited this starter has a row standing in for it, and addressing the
         * starter by key has to reach that row — otherwise the picker would offer the customised one
         * and pressing it would make the shipped one.
         */
        const [override] = await tx
          .select()
          .from(templates)
          .where(and(eq(templates.workspaceId, workspaceId), eq(templates.key, starterKey)))
          .limit(1)
        if (override)
          return {
            kind: override.kind as TemplateKind,
            name: override.name,
            doc: (override.doc ?? {}) as PageDoc,
            variables: (override.variables ?? []) as TemplateVariable[],
          }
        return {
          kind: 'page',
          name: s[`${starterKey}.name` as StarterStringKey],
          doc: starterDoc(starterKey, s),
          variables: [],
        }
      }
      const row = await this.row(tx, workspaceId, templateId as string)
      return {
        kind: row.kind as TemplateKind,
        name: row.name,
        doc: (row.doc ?? {}) as PageDoc,
        variables: (row.variables ?? []) as TemplateVariable[],
      }
    },

    /**
     * Make a page from a page template.
     *
     * The page is created exactly as `pages.create` makes one — same ranks, same parent rules — and
     * then given a body. A template is a starting point, not a different kind of page.
     */
    async instantiatePage(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      resolved: { name: string; doc: PageDoc; variables: TemplateVariable[] },
      input: {
        spaceId: string
        parentId: string | null
        afterId: string | null
        title: string
        values: Record<string, string>
      },
    ): Promise<TemplateResult> {
      const space = await access.spaceRow(tx, workspaceId, input.spaceId)
      const values = valuesFor(principal, principal.locale, space.name, resolved.variables, input.values)
      const title = fillText(input.title || resolved.name, values).slice(0, 300)
      const page = await pagesSvc.create(tx, principal, workspaceId, {
        spaceId: input.spaceId,
        parentId: input.parentId,
        title,
        kind: 'page',
        icon: null,
        afterId: input.afterId,
      })
      await writeBody(tx, workspaceId, page.id, fillPageDoc(resolved.doc, values))
      return { spaceId: input.spaceId, pageId: page.id, pageCount: 1 }
    },

    /**
     * Make a whole space from a space template.
     *
     * The tree is written depth-first with `pages.create`, so every page gets a real rank among its
     * siblings rather than a rank this file invents — the one thing that must not be re-implemented,
     * because two orderings of the same tree is a sidebar that disagrees with itself.
     */
    async instantiateSpace(
      tx: Tx,
      principal: Principal,
      workspaceId: string,
      resolved: { name: string; doc: PageDoc; variables: TemplateVariable[] },
      input: { key: string; name: string; values: Record<string, string> },
    ): Promise<TemplateResult> {
      const parsed = TemplateSpaceBody.safeParse(resolved.doc)
      if (!parsed.success) throw KernError.badRequest('This template does not hold a space')

      const values = valuesFor(principal, principal.locale, input.name, resolved.variables, input.values)
      const space = await spacesSvc.create(tx, principal, workspaceId, {
        key: input.key,
        name: fillText(input.name, values).slice(0, 120),
        description: '',
        icon: null,
        visibility: 'open',
      })

      let made = 0
      let first: string | null = null
      const write = async (nodes: TemplateSpaceNode[], parentId: string | null): Promise<void> => {
        let afterId: string | null = null
        for (const node of nodes) {
          if (made >= MAX_TEMPLATE_PAGES)
            throw KernError.badRequest(`A space template makes at most ${MAX_TEMPLATE_PAGES} pages`)
          const page = await pagesSvc.create(tx, principal, workspaceId, {
            spaceId: space.id,
            parentId,
            title: fillText(node.title, values).slice(0, 300),
            kind: 'page',
            icon: node.icon,
            afterId,
          })
          made += 1
          first ??= page.id
          afterId = page.id
          await writeBody(tx, workspaceId, page.id, fillPageDoc(node.doc as PageDoc, values))
          await write(node.children, page.id)
        }
      }
      await write(parsed.data.pages, null)

      // Opening a space means opening its home page, so the first page of the template is it. A
      // template with no pages leaves it null rather than pointing at nothing.
      if (first) await spacesSvc.update(tx, workspaceId, space.id, { homepageId: first })
      return { spaceId: space.id, pageId: first, pageCount: made }
    },
  }
}
export type QuireTemplates = ReturnType<typeof quireTemplates>
