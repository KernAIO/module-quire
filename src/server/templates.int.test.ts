/**
 * Templates, against a real Postgres.
 *
 * Four things are worth proving here and nowhere else, and each of them is a way this feature can be
 * wrong while every type checks and every other test passes.
 *
 *   1. **A variable's value is data, not syntax.** The obvious way to fill a template is
 *      `JSON.stringify` → `String.replace` → `JSON.parse`, and it is broken twice: a value containing
 *      `"` ends the string it was pasted into, and `$&` in a *replacement* is a back-reference. The
 *      test the brief asks for fills one variable with a quote, a brace pair, a newline and an emoji
 *      at once and reads the characters back out of the page.
 *   2. **A starter is a constant, and a row replaces it rather than joining it.** Five entries before
 *      an override, five after, and the shipped one back when the row is deleted.
 *   3. **A starter is prose, so it has a language.** The same call by a Persian reader and an English
 *      one must not produce the same headings.
 *   4. **Saving a page as a template is a read of that page.** A template is prose lifted somewhere
 *      more visible, so a page-scoped DENY has to refuse it — and a space template must leave out
 *      the pages its author cannot open rather than copying them into something everybody can.
 */
import { randomUUID } from 'node:crypto'
import type { Principal } from '@kernhq/contracts'
import { createKernel, KernError, type Kernel, type RequestContext, type Tx } from '@kernhq/kernel'
import type { PageDoc } from '@kernhq/ui/editor/page-doc'
import { call } from '@orpc/server'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Template, TemplateChoice, TemplateResult } from '../contract/index.js'
import { implement_ } from './_impl.js'
import { pageDocFromBase64 } from './document.js'
import { pageDocToYState } from './import/ydoc.js'
import { quireModule } from './index.js'
import { renderPageDoc, textFromPageDoc } from './render.js'
import { type QuireServices, quireServices } from './services/index.js'
import { documentNameOf } from './services/pages.js'

const BASE_URL = process.env.DATABASE_URL ?? 'postgres://kern:kern@localhost:5432/kern'
const DB_NAME = `kern_quire_tpl_${Date.now().toString(36)}`

const WS = randomUUID()
const OWNER = randomUUID()
/** An admin who is denied one thing at a time, so a refusal can only come from that one thing. */
const SWEEP = randomUUID()

let kernel: Kernel
let svc: QuireServices
let admin: pg.Client
let router: ReturnType<typeof implement_>

interface Binding {
  subjectType: 'user' | 'group' | 'builtin_role'
  subjectId: string
  permissions: string[]
  scopeKind: 'workspace' | 'project' | 'space' | 'object'
  scopeId: string
  deny: boolean
}
const bindings = new Map<string, Binding[]>()

const principal = (
  userId: string,
  role: 'owner' | 'admin' | 'member' = 'admin',
  locale = 'en',
  name = 'Ada Lovelace',
): Principal =>
  ({
    kind: 'user',
    userId,
    email: `${userId}@example.test`,
    name,
    locale,
    instanceAdmin: false,
    service: null,
    memberships: [{ workspaceId: WS, role, roleIds: [], groupIds: [], status: 'active' }],
    permissionVersion: 0,
  }) as Principal

const owner = () => principal(OWNER, 'owner')
const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  kernel.database.withWorkspace(WS, fn, { userId: OWNER })

const context = (who: Principal): RequestContext => ({
  kernel,
  principal: who,
  requestId: randomUUID(),
  ip: '127.0.0.1',
  headers: {},
})

const procedureAt = (name: string): unknown =>
  name
    .split('.')
    .reduce<Record<string, unknown>>(
      (node, key) => node[key] as Record<string, unknown>,
      router as unknown as Record<string, unknown>,
    )

/* The router is walked as data, so the leaf is untyped — `noExplicitAny` is off in a test file. */
const invoke = <T>(name: string, input: Record<string, unknown>, who: Principal): Promise<T> =>
  call(procedureAt(name) as any, input as any, { context: context(who) }) as Promise<T>

const codeOf = (err: unknown) => (err instanceof KernError ? err.code : `${(err as Error)?.name}`)
const outcome = (p: Promise<unknown>) => p.then(() => 'succeeded', codeOf)

/**
 * The collab stub, keeping **base64 verbatim**.
 *
 * The other integration files in this package store a decoded string, which is fine when the test
 * only cares that a replace is not a merge. Here the bytes are the point: `createFromPage` reads a
 * page's document back and decodes it, so anything that mangles binary makes every template empty
 * and the failure looks like the template code rather than the fixture.
 */
const documents = new Map<string, string>()
function registerStubs(k: Kernel) {
  k.broker.register('collab', {
    'document.state': {
      handler: async (input: { name: string }) => ({
        name: input.name,
        state: documents.get(input.name) ?? null,
        size: documents.get(input.name)?.length ?? 0,
        updatedAt: documents.has(input.name) ? new Date().toISOString() : null,
      }),
    },
    'document.snapshot': {
      handler: async (input: { name: string }) => {
        const state = documents.get(input.name)
        if (!state) throw new Error('no document')
        return { snapshot: state, state }
      },
    },
    'document.apply': { handler: async () => ({ ok: true as const, size: 0 }) },
    'document.replace': {
      handler: async (input: { name: string; state: string }) => {
        documents.set(input.name, input.state)
        return { ok: true as const, size: input.state.length }
      },
    },
    'document.delete': {
      handler: async (input: { name: string }) => {
        documents.delete(input.name)
        return { ok: true as const }
      },
    },
  })
  k.broker.register('core', {
    'activity.record': { handler: async () => ({ ok: true }) },
    'notifications.create': { handler: async () => ({ ok: true }) },
    'search.index': { handler: async () => ({ ok: true }) },
    'search.remove': { handler: async () => ({ ok: true }) },
    'modules.isEnabled': { handler: async () => true },
    'users.principal': { handler: async (input: { userId: string }) => principal(input.userId) },
    'authz.customRolePermissions': { handler: async () => [] },
    'authz.bindings': { handler: async (input: { userId: string }) => bindings.get(input.userId) ?? [] },
    'settings.getModule': { handler: async () => ({}) },
  })
}

const deny = (userId: string, permissions: string[], scopeKind: Binding['scopeKind'], scopeId: string) =>
  bindings.set(userId, [
    { subjectType: 'user', subjectId: userId, permissions, scopeKind, scopeId, deny: true },
  ])

/** A page with something actually written in it, so a template made from it is not empty. */
async function writePage(pageId: string, doc: PageDoc): Promise<void> {
  documents.set(documentNameOf({ workspaceId: WS, id: pageId }), pageDocToYState(doc).toString('base64'))
}

const docOf = (pageId: string): PageDoc | null =>
  pageDocFromBase64(documents.get(documentNameOf({ workspaceId: WS, id: pageId })) ?? null)

const para = (text: string): PageDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
})

let spaceId = ''
let pageId = ''
/** A page in the same space the sweep principal is denied by name. */
let secretPageId = ''

beforeAll(async () => {
  admin = new pg.Client({ connectionString: BASE_URL })
  await admin.connect()
  await admin.query(`create database "${DB_NAME}"`)
  const url = new URL(BASE_URL)
  url.pathname = `/${DB_NAME}`

  kernel = await createKernel({
    service: 'quire-templates-test',
    modules: [quireModule],
    role: 'api',
    env: {
      DATABASE_URL: url.toString(),
      KERN_SECRET: 'test-secret-that-is-long-enough-for-kern',
      NODE_ENV: 'test',
      NATS_URL: undefined,
      VALKEY_URL: undefined,
    },
  })
  registerStubs(kernel)
  await kernel.start()
  svc = quireServices(kernel)
  router = implement_(kernel)

  const space = await run((tx) =>
    svc.spaces.create(tx, owner(), WS, {
      key: 'handbook',
      name: 'Handbook',
      description: '',
      icon: null,
      visibility: 'open',
    }),
  )
  spaceId = space.id

  const page = await run((tx) =>
    svc.pages.create(tx, owner(), WS, {
      spaceId,
      parentId: null,
      title: 'Weekly review',
      kind: 'page',
      icon: null,
      afterId: null,
    }),
  )
  pageId = page.id
  await writePage(pageId, para('Sprint {{sprint}} · owner {{author}}'))

  const secret = await run((tx) =>
    svc.pages.create(tx, owner(), WS, {
      spaceId,
      parentId: null,
      title: 'Redundancy plan',
      kind: 'page',
      icon: null,
      afterId: null,
    }),
  )
  secretPageId = secret.id
  await writePage(secretPageId, para('Names and dates nobody else may read'))
}, 180_000)

afterAll(async () => {
  await kernel?.stop().catch(() => undefined)
  await admin.query(`drop database if exists "${DB_NAME}" with (force)`).catch(() => undefined)
  await admin.end().catch(() => undefined)
}, 60_000)

beforeEach(() => bindings.clear())

/** Every template this workspace has, so a test can clean up after itself. */
const listAll = (kind: 'page' | 'space' = 'page') =>
  invoke<TemplateChoice[]>('templates.list', { workspaceId: WS, kind, spaceId }, owner())

async function removeAllTemplates(): Promise<void> {
  for (const kind of ['page', 'space'] as const)
    for (const choice of await listAll(kind))
      if (choice.id)
        await invoke('templates.remove', { workspaceId: WS, templateId: choice.id }, owner()).catch(
          () => undefined,
        )
}

// =====================================================================================

describe('the five starters Kern ships', () => {
  it('are offered in a workspace that has never written a template', async () => {
    const list = await listAll()
    expect(list.map((c) => c.key)).toEqual([
      'meeting-notes',
      'decision-record',
      'requirements',
      'retrospective',
      'how-to',
    ])
    // A constant has no row, so it has no id — that is the whole shape of the compromise, and a
    // client telling the two apart is what makes "reset to the shipped one" expressible.
    expect(list.every((c) => c.id === null && c.builtIn)).toBe(true)
    expect(list.every((c) => c.name.length > 0 && c.description.length > 0)).toBe(true)
  })

  it('speak the reader’s language rather than the release’s', async () => {
    const english = await invoke<TemplateChoice[]>(
      'templates.list',
      { workspaceId: WS, kind: 'page', spaceId },
      principal(OWNER, 'owner', 'en'),
    )
    const persian = await invoke<TemplateChoice[]>(
      'templates.list',
      { workspaceId: WS, kind: 'page', spaceId },
      principal(OWNER, 'owner', 'fa'),
    )
    expect(english[0]?.name).toBe('Meeting notes')
    expect(persian[0]?.name).not.toBe(english[0]?.name)
    // A region tag is still a language: `en-GB` must not fall through to the raw key set.
    const british = await invoke<TemplateChoice[]>(
      'templates.list',
      { workspaceId: WS, kind: 'page', spaceId },
      principal(OWNER, 'owner', 'en-GB'),
    )
    expect(british[0]?.name).toBe('Meeting notes')
  })

  it('make a page whose body the static renderer can actually draw', async () => {
    const made = await invoke<TemplateResult>(
      'templates.instantiate',
      { workspaceId: WS, starterKey: 'retrospective', spaceId, title: '' },
      owner(),
    )
    expect(made.pageCount).toBe(1)
    const doc = docOf(made.pageId!)
    expect(doc, 'the starter body never reached the page').not.toBeNull()

    const html = renderPageDoc(doc)
    // Every node in a starter has a renderer, so nothing is silently dropped: the headings the
    // starter declares are in the HTML a published or exported copy would carry.
    expect(html).toContain('<h2>')
    expect(html).toContain('<ul')
    expect(html).toContain('data-type="taskList"')

    // `{{date}}` and `{{author}}` are filled from the request, so no braces survive.
    const text = textFromPageDoc(doc)
    expect(text).not.toContain('{{')
    expect(text).toContain('Ada Lovelace')
  })

  it('are made in the reader’s language too, not only listed in it', async () => {
    const made = await invoke<TemplateResult>(
      'templates.instantiate',
      { workspaceId: WS, starterKey: 'how-to', spaceId, title: '' },
      principal(OWNER, 'owner', 'de'),
    )
    expect(textFromPageDoc(docOf(made.pageId!))).toContain('Schritte')
  })
})

describe('a workspace that edits a starter', () => {
  it('replaces it in the picker rather than sitting beside it, and resets by deleting the row', async () => {
    await removeAllTemplates()
    const before = await listAll()
    expect(before).toHaveLength(5)

    const mine = await invoke<Template>(
      'templates.createFromPage',
      {
        workspaceId: WS,
        kind: 'page',
        sourceId: pageId,
        spaceId: null,
        name: 'Our retrospective',
        key: 'retrospective',
      },
      owner(),
    )
    expect(mine.builtIn).toBe(true)

    const after = await listAll()
    expect(after, 'the override was added beside the starter instead of standing in for it').toHaveLength(5)
    const slot = after.find((c) => c.key === 'retrospective')
    expect(slot?.id).toBe(mine.id)
    expect(slot?.name).toBe('Our retrospective')

    // Addressing the starter by key has to reach the row, or the picker offers one thing and
    // pressing it makes another.
    const made = await invoke<TemplateResult>(
      'templates.instantiate',
      { workspaceId: WS, starterKey: 'retrospective', spaceId, title: 'From ours' },
      owner(),
    )
    expect(textFromPageDoc(docOf(made.pageId!))).toContain('Sprint')

    await invoke('templates.remove', { workspaceId: WS, templateId: mine.id }, owner())
    const reset = await listAll()
    expect(reset).toHaveLength(5)
    expect(reset.find((c) => c.key === 'retrospective')?.id, 'the shipped starter did not come back').toBe(
      null,
    )
  })

  it('cannot override the same starter twice', async () => {
    await removeAllTemplates()
    const input = {
      workspaceId: WS,
      kind: 'page',
      sourceId: pageId,
      spaceId: null,
      name: 'Ours',
      key: 'how-to',
    }
    await invoke('templates.createFromPage', input, owner())
    expect(await outcome(invoke('templates.createFromPage', { ...input, name: 'Ours again' }, owner()))).toBe(
      'CONFLICT',
    )
    await removeAllTemplates()
  })
})

describe('filling a variable in', () => {
  let templateId = ''

  beforeAll(async () => {
    const created = await run((tx) =>
      svc.templates.createFromPage(tx, owner(), WS, {
        kind: 'page',
        sourceId: pageId,
        spaceId,
        name: 'Sprint review',
        description: '',
        icon: null,
        key: null,
        variables: [
          {
            name: 'sprint',
            label: 'Which sprint',
            type: 'text',
            options: [],
            default: null,
            required: true,
          },
        ],
      }),
    )
    templateId = created.id
  })

  /**
   * The one the brief asks for, and the reason this file exists.
   *
   * Every character here breaks a different shortcut: `"` ends a JSON string, `{{` looks like
   * another placeholder, `\n` is illegal raw inside a JSON string, and the emoji is a surrogate pair
   * that a byte-wise slice would cut in half. A page that survives all four was built by walking the
   * document, which is the only way it can be.
   */
  it('keeps a quote, a brace pair, a newline and an emoji exactly as they were typed', async () => {
    const value = 'Q3 "final" {{not-a-variable}}\nwith a rocket 🚀'
    const made = await invoke<TemplateResult>(
      'templates.instantiate',
      { workspaceId: WS, templateId, spaceId, title: 'Sprint {{sprint}}', values: { sprint: value } },
      owner(),
    )

    const doc = docOf(made.pageId!)
    expect(doc, 'the filled body never reached the page').not.toBeNull()
    const text = textFromPageDoc(doc)
    expect(text).toContain('"final"')
    expect(text).toContain('{{not-a-variable}}')
    expect(text).toContain('🚀')
    expect(text).toContain('\nwith a rocket')
    // The placeholder itself is gone: the value went in, not beside it.
    expect(text).not.toContain('{{sprint}}')

    // And the document is still a document: the renderer draws it, escaping the quote rather than
    // letting it out into an attribute.
    const html = renderPageDoc(doc)
    expect(html).toContain('&quot;final&quot;')
    expect(html).toContain('🚀')
    expect(html).not.toContain('"final"')

    // The title took the same walk. A title is a column rather than a document, so it is the one
    // place a second, hand-rolled substitution would have been easy to write and easy to get wrong.
    const page = await run((tx) => svc.pages.get(tx, WS, made.pageId!))
    expect(page.title).toContain('"final"')
    expect(page.title).toContain('🚀')
  })

  /**
   * `$&`, `$1` and `$'` are back-references in a `String.replace` *replacement*.
   *
   * A string replacement would paste the placeholder back for `$&` and the rest of the paragraph for
   * `$'`. The function form is what makes an answer data; nothing about the feature looks different
   * until somebody types a dollar sign.
   */
  it('treats a dollar sign in the answer as a dollar sign', async () => {
    const made = await invoke<TemplateResult>(
      'templates.instantiate',
      { workspaceId: WS, templateId, spaceId, title: '', values: { sprint: "$& $1 $' $$" } },
      owner(),
    )
    expect(textFromPageDoc(docOf(made.pageId!))).toContain("$& $1 $' $$")
  })

  it('refuses to make the page when something required is missing', async () => {
    expect(
      await outcome(
        invoke('templates.instantiate', { workspaceId: WS, templateId, spaceId, values: {} }, owner()),
      ),
    ).toBe('BAD_REQUEST')
  })

  it('leaves a name nothing declared on the page, where its author can see it', async () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '{{nope}}' }] }],
    }
    const scratch = await run((tx) =>
      svc.pages.create(tx, owner(), WS, {
        spaceId,
        parentId: null,
        title: 'Scratch',
        kind: 'page',
        icon: null,
        afterId: null,
      }),
    )
    await writePage(scratch.id, doc as PageDoc)
    const template = await run((tx) =>
      svc.templates.createFromPage(tx, owner(), WS, {
        kind: 'page',
        sourceId: scratch.id,
        spaceId,
        name: 'Undeclared',
        description: '',
        icon: null,
        key: null,
        variables: [],
      }),
    )
    const made = await invoke<TemplateResult>(
      'templates.instantiate',
      { workspaceId: WS, templateId: template.id, spaceId },
      owner(),
    )
    expect(textFromPageDoc(docOf(made.pageId!))).toContain('{{nope}}')
    await invoke('templates.remove', { workspaceId: WS, templateId: template.id }, owner())
  })

  /**
   * A link's `href` is not prose.
   *
   * Substituting attributes would let a template author write half a URL and have somebody else's
   * answer complete it — a link whose destination is decided by whoever filled the form in.
   */
  it('does not substitute inside an attribute', async () => {
    const scratch = await run((tx) =>
      svc.pages.create(tx, owner(), WS, {
        spaceId,
        parentId: null,
        title: 'Linky',
        kind: 'page',
        icon: null,
        afterId: null,
      }),
    )
    await writePage(scratch.id, {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'here',
              marks: [{ type: 'link', attrs: { href: 'https://example.test/{{sprint}}' } }],
            },
          ],
        },
      ],
    })
    const template = await run((tx) =>
      svc.templates.createFromPage(tx, owner(), WS, {
        kind: 'page',
        sourceId: scratch.id,
        spaceId,
        name: 'Linked',
        description: '',
        icon: null,
        key: null,
        variables: [
          { name: 'sprint', label: 'Sprint', type: 'text', options: [], default: null, required: false },
        ],
      }),
    )
    const made = await invoke<TemplateResult>(
      'templates.instantiate',
      { workspaceId: WS, templateId: template.id, spaceId, values: { sprint: 'evil.example' } },
      owner(),
    )
    const html = renderPageDoc(docOf(made.pageId!))
    expect(html, 'the answer reached a link’s destination').not.toContain('evil.example')
    expect(html).toContain('https://example.test/{{sprint}}')
    await invoke('templates.remove', { workspaceId: WS, templateId: template.id }, owner())
  })
})

describe('saving a page as a template is a read of that page', () => {
  it('refuses somebody a page-scoped DENY has closed the page to', async () => {
    deny(SWEEP, ['quire.page.view'], 'object', secretPageId)
    expect(
      await outcome(
        invoke(
          'templates.createFromPage',
          { workspaceId: WS, kind: 'page', sourceId: secretPageId, spaceId, name: 'Lifted' },
          principal(SWEEP, 'admin'),
        ),
      ),
      'a template is prose moved somewhere more visible, so the read has to be checked',
    ).toBe('FORBIDDEN')
  })

  it('refuses somebody who may read the page but not configure the space it is offered in', async () => {
    deny(SWEEP, ['quire.space.manage'], 'space', spaceId)
    expect(
      await outcome(
        invoke(
          'templates.createFromPage',
          { workspaceId: WS, kind: 'page', sourceId: pageId, spaceId, name: 'Not yours to add' },
          principal(SWEEP, 'admin'),
        ),
      ),
    ).toBe('FORBIDDEN')
  })

  it('refuses a page with nothing written on it', async () => {
    const blank = await run((tx) =>
      svc.pages.create(tx, owner(), WS, {
        spaceId,
        parentId: null,
        title: 'Never opened',
        kind: 'page',
        icon: null,
        afterId: null,
      }),
    )
    expect(
      await outcome(
        invoke(
          'templates.createFromPage',
          { workspaceId: WS, kind: 'page', sourceId: blank.id, spaceId, name: 'Empty' },
          owner(),
        ),
      ),
    ).toBe('BAD_REQUEST')
  })
})

describe('a whole space saved as a template', () => {
  it('leaves out the pages its author may not read, and makes the rest again', async () => {
    // The author is denied one page of the space, so a template that copied everything would carry
    // that page's prose to anybody who may create a page.
    deny(SWEEP, ['quire.page.view'], 'object', secretPageId)
    const template = await invoke<Template>(
      'templates.createFromPage',
      { workspaceId: WS, kind: 'space', sourceId: spaceId, spaceId: null, name: 'A handbook' },
      principal(SWEEP, 'admin'),
    )
    bindings.clear()

    const body = JSON.stringify(template.doc)
    expect(body, 'a page the author cannot open was copied into the template').not.toContain(
      'Names and dates nobody else may read',
    )
    expect(body).toContain('Sprint')

    const made = await invoke<TemplateResult>(
      'templates.instantiate',
      { workspaceId: WS, templateId: template.id, key: 'handbook-2', name: 'Handbook copy' },
      owner(),
    )
    expect(made.pageCount).toBeGreaterThan(0)
    expect(made.pageId).not.toBeNull()

    const space = await run((tx) => svc.spaces.get(tx, owner(), WS, made.spaceId))
    expect(space.key).toBe('handbook-2')
    // Opening a space means opening its home page, so a space made from a template has one.
    expect(space.homepageId).toBe(made.pageId)

    const tree = await run((tx) => svc.pages.tree(tx, WS, made.spaceId, false))
    expect(tree.length).toBe(made.pageCount)
    expect(tree.map((n) => n.title)).toContain('Weekly review')
    expect(tree.map((n) => n.title)).not.toContain('Redundancy plan')

    await invoke('templates.remove', { workspaceId: WS, templateId: template.id }, owner())
  })

  it('refuses to make a space for somebody who may not make spaces', async () => {
    const template = await invoke<Template>(
      'templates.createFromPage',
      { workspaceId: WS, kind: 'space', sourceId: spaceId, spaceId: null, name: 'A handbook' },
      owner(),
    )
    /*
     * Denied at **workspace** scope, because that is the only scope a space that does not exist yet
     * can be refused at — the same question `spaces.create` asks. The sweep in `authz.int.test.ts`
     * sends the page branch of this procedure and cannot see this one.
     */
    deny(SWEEP, ['quire.space.manage'], 'workspace', WS)
    expect(
      await outcome(
        invoke(
          'templates.instantiate',
          { workspaceId: WS, templateId: template.id, key: 'nope', name: 'Nope' },
          principal(SWEEP, 'admin'),
        ),
      ),
    ).toBe('FORBIDDEN')
    bindings.clear()
    await invoke('templates.remove', { workspaceId: WS, templateId: template.id }, owner())
  })

  it('cannot be scoped to a space, because it makes one', async () => {
    expect(
      await outcome(
        invoke(
          'templates.createFromPage',
          { workspaceId: WS, kind: 'space', sourceId: spaceId, spaceId, name: 'Nonsense' },
          owner(),
        ),
      ),
    ).toBe('BAD_REQUEST')
  })
})

describe('where a template is offered', () => {
  it('shows a space-scoped one only in its own space, and a workspace-wide one everywhere', async () => {
    await removeAllTemplates()
    const other = await run((tx) =>
      svc.spaces.create(tx, owner(), WS, {
        key: 'engineering',
        name: 'Engineering',
        description: '',
        icon: null,
        visibility: 'open',
      }),
    )
    const scoped = await run((tx) =>
      svc.templates.createFromPage(tx, owner(), WS, {
        kind: 'page',
        sourceId: pageId,
        spaceId,
        name: 'Handbook only',
        description: '',
        icon: null,
        key: null,
        variables: [],
      }),
    )
    const everywhere = await run((tx) =>
      svc.templates.createFromPage(tx, owner(), WS, {
        kind: 'page',
        sourceId: pageId,
        spaceId: null,
        name: 'Everywhere',
        description: '',
        icon: null,
        key: null,
        variables: [],
      }),
    )

    const here = await invoke<TemplateChoice[]>(
      'templates.list',
      { workspaceId: WS, kind: 'page', spaceId },
      owner(),
    )
    const there = await invoke<TemplateChoice[]>(
      'templates.list',
      { workspaceId: WS, kind: 'page', spaceId: other.id },
      owner(),
    )
    const nowhere = await invoke<TemplateChoice[]>(
      'templates.list',
      { workspaceId: WS, kind: 'page', spaceId: null },
      owner(),
    )

    expect(here.map((c) => c.id)).toContain(scoped.id)
    expect(here.map((c) => c.id)).toContain(everywhere.id)
    expect(there.map((c) => c.id)).not.toContain(scoped.id)
    expect(there.map((c) => c.id)).toContain(everywhere.id)
    // The "New space" picker asks before there is a space, and gets the workspace-wide answer.
    expect(nowhere.map((c) => c.id)).not.toContain(scoped.id)
    expect(nowhere.map((c) => c.id)).toContain(everywhere.id)

    await removeAllTemplates()
  })

  it('refuses to list a space this person may not see', async () => {
    deny(SWEEP, ['quire.space.view'], 'space', spaceId)
    expect(
      await outcome(
        invoke('templates.list', { workspaceId: WS, kind: 'page', spaceId }, principal(SWEEP, 'admin')),
      ),
    ).toBe('FORBIDDEN')
  })
})

describe('editing a template', () => {
  it('takes a new body from a page, and re-asks whether that page may be read', async () => {
    await removeAllTemplates()
    const template = await invoke<Template>(
      'templates.createFromPage',
      { workspaceId: WS, kind: 'page', sourceId: pageId, spaceId, name: 'Editable' },
      owner(),
    )

    deny(SWEEP, ['quire.page.view'], 'object', secretPageId)
    expect(
      await outcome(
        invoke(
          'templates.update',
          { workspaceId: WS, templateId: template.id, sourceId: secretPageId },
          principal(SWEEP, 'admin'),
        ),
      ),
      'replacing a body is the same read as taking one, and needs the same permission',
    ).toBe('FORBIDDEN')
    bindings.clear()

    const updated = await invoke<Template>(
      'templates.update',
      { workspaceId: WS, templateId: template.id, name: 'Renamed', sourceId: secretPageId },
      owner(),
    )
    expect(updated.name).toBe('Renamed')
    expect(JSON.stringify(updated.doc)).toContain('Names and dates')

    await invoke('templates.remove', { workspaceId: WS, templateId: template.id }, owner())
  })

  /**
   * `update` looks like a rename, which is why this is easy to leave out.
   *
   * Sending `sourceId` re-reads a whole space's prose into the template, so it is the same act as
   * `createFromPage` and needs the same permission — a check on the *create* door only is a check
   * somebody walks around by editing an existing template instead.
   */
  it('re-asks about the space when a space template’s body is replaced', async () => {
    const template = await invoke<Template>(
      'templates.createFromPage',
      { workspaceId: WS, kind: 'space', sourceId: spaceId, spaceId: null, name: 'A shape' },
      owner(),
    )
    deny(SWEEP, ['quire.space.manage'], 'space', spaceId)
    expect(
      await outcome(
        invoke(
          'templates.update',
          { workspaceId: WS, templateId: template.id, sourceId: spaceId },
          principal(SWEEP, 'admin'),
        ),
      ),
    ).toBe('FORBIDDEN')
    bindings.clear()
    await invoke('templates.remove', { workspaceId: WS, templateId: template.id }, owner())
  })

  it('refuses two fields with the same name', async () => {
    const twice = {
      workspaceId: WS,
      kind: 'page',
      sourceId: pageId,
      spaceId,
      name: 'Confused',
      variables: [
        { name: 'sprint', label: 'One', type: 'text', options: [], default: null, required: false },
        { name: 'sprint', label: 'Two', type: 'text', options: [], default: null, required: false },
      ],
    }
    expect(await outcome(invoke('templates.createFromPage', twice, owner()))).toBe('BAD_REQUEST')
  })

  it('refuses a variable named after one the module fills itself', async () => {
    // `TemplateVariableName` refuses it in the contract, so this never reaches a handler — which is
    // the right place for it, and worth pinning: `{{date}}` meaning two things is a template whose
    // output depends on which substitution ran first.
    const reserved = {
      workspaceId: WS,
      kind: 'page',
      sourceId: pageId,
      spaceId,
      name: 'Reserved',
      variables: [{ name: 'date', label: 'When', type: 'date', options: [], default: null, required: false }],
    }
    expect(await outcome(invoke('templates.createFromPage', reserved, owner()))).not.toBe('succeeded')
  })
})
