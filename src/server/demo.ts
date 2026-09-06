/**
 * Demo content for Quire.
 *
 * Three spaces with a real page tree, prose in every page, and one database with its own properties
 * and rows — the three things the module is judged on, and the three that an empty workspace shows
 * none of.
 *
 * A page's body is a CRDT held by the collab service, not a column here, so writing one means the
 * same three steps `templates.ts`'s `writeBody` performs: encode the document as a Y update, hand it
 * to `collab.document.replace`, and mirror the flattened text onto `pages.text` so the page is
 * findable before anybody opens it. A version row is deliberately not written, for the reason given
 * there: none of `VersionKind`'s values honestly describes "this is how the page arrived".
 */
import type { DemoSeedContext, DemoSeedSummary, Tx } from '@kernhq/kernel'
import type { PageDoc } from '@kernhq/ui/editor/page-doc'
import { and, eq } from 'drizzle-orm'
import { pageDocToYState } from './import/ydoc.js'
import { textFromPageDoc } from './render.js'
import { pages, spaces } from './schema.js'
import { type QuireServices, quireServices } from './services/index.js'
import { documentNameOf } from './services/pages.js'

/** A paragraph. */
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] })
/** A heading. */
const h = (level: number, text: string) => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
})
/** A bulleted list, one string per item. */
const ul = (items: string[]) => ({
  type: 'bulletList',
  content: items.map((text) => ({ type: 'listItem', content: [p(text)] })),
})
const doc = (...content: unknown[]): PageDoc => ({ type: 'doc', content }) as PageDoc

interface PageSeed {
  title: string
  icon?: string
  body: PageDoc
  children?: PageSeed[]
}

const HANDBOOK: PageSeed[] = [
  {
    title: 'Welcome',
    icon: '👋',
    body: doc(
      p(
        'This is the handbook. Everything that is true for everybody lives here, and everything that is true for one team lives in that team’s space.',
      ),
      h(2, 'How to use it'),
      ul([
        'If you had to ask someone, the answer belongs in here.',
        'Edit the page rather than adding a comment saying it is wrong.',
        'Every page has an owner. If you are the owner, you keep it true.',
      ]),
      p('Pages are collaborative: two people can type in the same paragraph and both keep their words.'),
    ),
    children: [
      {
        title: 'Your first week',
        icon: '🌱',
        body: doc(
          h(2, 'Day one'),
          ul([
            'Accounts: mail, this workspace, the code host.',
            'Meet your buddy — they are the person to interrupt.',
            'Read this handbook’s front page and nothing else.',
          ]),
          h(2, 'By the end of the week'),
          ul([
            'Ship something small to production.',
            'Sit in on a support shift for an hour.',
            'Write down three things that confused you and fix one of them here.',
          ]),
        ),
      },
      {
        title: 'How we work',
        icon: '🧭',
        body: doc(
          p(
            'Small changes, shipped often, in the open. Anything that takes longer than a fortnight is cut into pieces that do not.',
          ),
          h(2, 'Meetings'),
          ul([
            'A meeting has an agenda in a page before it starts, or it is a message.',
            'Half an hour by default. Nobody is offended by a meeting that ends early.',
            'Notes go in the space the work lives in, not in someone’s inbox.',
          ]),
          h(2, 'Writing'),
          p(
            'Write for the person who joins in six months. They will not have been in the conversation and cannot ask you about it.',
          ),
        ),
      },
    ],
  },
  {
    title: 'Time off',
    icon: '🏖️',
    body: doc(
      p(
        'Twenty-five days, plus public holidays where you live. Book it in the People section — this page is the policy, not the form.',
      ),
      h(2, 'The rules, all of them'),
      ul([
        'Take the days. An unused balance is not a badge.',
        'More than five days in a row: tell your team two weeks ahead.',
        'Sick leave is not holiday and is not counted against it.',
      ]),
    ),
  },
  {
    title: 'Expenses',
    icon: '🧾',
    body: doc(
      p('Spend what you would spend if it were your own money and you were slightly embarrassed about it.'),
      ul([
        'Under 100: buy it, upload the receipt.',
        'Over 100: ask first, in writing, so there is a record.',
        'Travel is booked at the cheapest reasonable option, not the cheapest possible one.',
      ]),
    ),
  },
]

const ENGINEERING: PageSeed[] = [
  {
    title: 'Architecture',
    icon: '🏗️',
    body: doc(
      p(
        'One service per runtime reason, and no more than that. A feature that has no runtime reason to be its own service lives in an existing one.',
      ),
      h(2, 'Services'),
      ul([
        'core — accounts, workspaces, permissions, files.',
        'chat — holds the websockets.',
        'mail — holds the provider connections.',
        'collab — CPU-bound document merging.',
      ]),
      h(2, 'Rules that are not negotiable'),
      ul([
        'A module owns its own schema and nothing reaches into it.',
        'Every tenant table carries the workspace id and a row-level policy.',
        'Migrations must survive being applied twice.',
      ]),
    ),
    children: [
      {
        title: 'Decision log',
        icon: '⚖️',
        body: doc(
          p(
            'One entry per decision that was hard to make and would be expensive to reverse. Short. What we decided, and what it cost.',
          ),
          h(2, 'Postgres for everything until it hurts'),
          p(
            'One database, one operational story. We will know it is time to add another store when a specific query is the reason, not when the diagram looks tidier.',
          ),
          h(2, 'No staging environment'),
          p(
            'Feature flags and a cloud instance that takes the release first. A staging environment nobody trusts is worse than none.',
          ),
        ),
      },
    ],
  },
  {
    title: 'Runbook: the site is down',
    icon: '🚨',
    body: doc(
      p('Read this top to bottom. Do not skip to the part you think it is.'),
      h(2, '1. Say something'),
      p('Post in the incident channel before you start looking. Somebody else is already looking too.'),
      h(2, '2. Establish what is actually broken'),
      ul([
        'Health endpoint — does it answer, and with which version?',
        'Are all the containers running, or only most of them?',
        'Did anything deploy in the last hour?',
      ]),
      h(2, '3. Get it working, then find out why'),
      p(
        'A rollback is not an admission of anything. Restore service first; the cause will still be there afterwards.',
      ),
    ),
  },
  {
    title: 'Code review',
    icon: '🔍',
    body: doc(
      p('A review is a conversation about a change, not a gate somebody stands at.'),
      ul([
        'Say what you would change and why, not that it is wrong.',
        'Two reviewers only if the change is genuinely risky.',
        'Approving means you would be comfortable being paged for it.',
      ]),
    ),
  },
]

const PRODUCT: PageSeed[] = [
  {
    title: 'This quarter',
    icon: '🎯',
    body: doc(
      p('Three things. Anything that is not one of these is a distraction we have agreed to say no to.'),
      ul([
        'Offline mode in the mobile app.',
        'A website that explains what this is in ten seconds.',
        'Cut the time from sign-up to first useful screen below two minutes.',
      ]),
      h(2, 'Not this quarter'),
      ul(['Single sign-on.', 'The public API.', 'Anything with the word "platform" in it.']),
    ),
  },
  {
    title: 'What customers keep asking for',
    icon: '📣',
    body: doc(
      p('Kept in order of how often it comes up, not of how much we would like to build it.'),
      ul([
        'Bulk actions in the issue list — six requests this quarter.',
        'Moving a project between workspaces — four.',
        'A dark mode that follows the system — three, all from the mobile app.',
        'Exports that do not time out on large workspaces — two, both on the business plan.',
      ]),
    ),
  },
  {
    title: 'Research: onboarding',
    icon: '🔬',
    body: doc(
      p('Six sessions, forty minutes each, people who had signed up in the previous week and not come back.'),
      h(2, 'What we saw'),
      ul([
        'Four of six landed on an empty workspace and did not know what to do next.',
        'Nobody read the empty-state text. Two scrolled past it looking for a button.',
        'Everyone who was shown a filled workspace understood the product inside a minute.',
      ]),
      h(2, 'What we changed'),
      p(
        'An option to fill a new workspace with example content, so the first screen shows the product working rather than describing itself.',
      ),
    ),
  },
]

/** The database on the product space's roadmap page. */
const ROADMAP_ROWS: Array<{ title: string; status: string; team: string; quarter: string }> = [
  { title: 'Offline mode', status: 'In progress', team: 'Mobile', quarter: 'This quarter' },
  { title: 'Website relaunch', status: 'In progress', team: 'Growth', quarter: 'This quarter' },
  { title: 'Demo content on sign-up', status: 'In progress', team: 'Growth', quarter: 'This quarter' },
  { title: 'Bulk actions', status: 'Planned', team: 'Core', quarter: 'Next quarter' },
  { title: 'Single sign-on', status: 'Planned', team: 'Core', quarter: 'Next quarter' },
  { title: 'Public API', status: 'Considering', team: 'Core', quarter: 'Later' },
  { title: 'Move a project between workspaces', status: 'Considering', team: 'Core', quarter: 'Later' },
  { title: 'Dark mode follows the system', status: 'Shipped', team: 'Mobile', quarter: 'Last quarter' },
]

export async function seedQuireDemo(ctx: DemoSeedContext): Promise<DemoSeedSummary> {
  const { kernel, workspaceId, actor, actorId } = ctx
  const svc = quireServices(kernel)

  return kernel.database.withWorkspace(
    workspaceId,
    async (tx) => {
      /*
       * See the tracker's seeder for why the guard reads the table rather than a marker row — and
       * why `workspace_id` is in the predicate instead of being left to row-level security. An
       * unscoped guard sees another workspace's spaces on any database whose owner can bypass a
       * policy, and reports an empty workspace as used.
       */
      const [existing] = await tx
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.workspaceId, workspaceId))
        .limit(1)
      if (existing) return { skipped: true }

      let pageCount = 0

      const handbook = await svc.spaces.create(tx, actor, workspaceId, {
        key: 'HB',
        name: 'Company handbook',
        description: 'How we work, what we agreed, and where the answers are.',
        icon: '📗',
        visibility: 'open',
      })
      const engineering = await svc.spaces.create(tx, actor, workspaceId, {
        key: 'ENG',
        name: 'Engineering',
        description: 'Architecture, runbooks and the decisions behind them.',
        icon: '🛠️',
        visibility: 'open',
      })
      const product = await svc.spaces.create(tx, actor, workspaceId, {
        key: 'PRD',
        name: 'Product',
        description: 'What we are building, what we are not, and why.',
        icon: '🧭',
        visibility: 'open',
      })

      for (const [space, seeds] of [
        [handbook.id, HANDBOOK],
        [engineering.id, ENGINEERING],
        [product.id, PRODUCT],
      ] as Array<[string, PageSeed[]]>)
        pageCount += await writeTree(tx, svc, ctx, space, null, seeds)

      const rows = await writeRoadmap(tx, svc, ctx, product.id)
      pageCount += rows + 1

      return { created: { spaces: 3, pages: pageCount, databaseRows: rows } }
    },
    { userId: actorId },
  )
}

async function writeTree(
  tx: Tx,
  svc: QuireServices,
  ctx: DemoSeedContext,
  spaceId: string,
  parentId: string | null,
  seeds: PageSeed[],
): Promise<number> {
  const { workspaceId, actor } = ctx
  let count = 0
  let afterId: string | null = null
  for (const seed of seeds) {
    const page = await svc.pages.create(tx, actor, workspaceId, {
      spaceId,
      parentId,
      title: seed.title,
      kind: 'page',
      icon: seed.icon ?? null,
      afterId,
    })
    afterId = page.id
    count += 1
    await writeBody(tx, ctx, page.id, seed.body)
    if (seed.children?.length) count += await writeTree(tx, svc, ctx, spaceId, page.id, seed.children)
  }
  return count
}

/** A database page with properties, views and rows — the same shape the editor's `/database` makes. */
async function writeRoadmap(
  tx: Tx,
  svc: QuireServices,
  ctx: DemoSeedContext,
  spaceId: string,
): Promise<number> {
  const { workspaceId, actor } = ctx
  const page = await svc.pages.create(tx, actor, workspaceId, {
    spaceId,
    parentId: null,
    title: 'Roadmap',
    kind: 'database',
    icon: '🗺️',
    afterId: null,
  })
  const database = await svc.databases.create(tx, actor, workspaceId, {
    spaceId,
    pageId: page.id,
    name: 'Roadmap',
    inline: false,
  })
  const status = await svc.databases.addProperty(tx, workspaceId, database.id, {
    name: 'Status',
    type: 'select',
    config: {
      options: [
        { id: 'shipped', name: 'Shipped', color: '#3aa17e' },
        { id: 'progress', name: 'In progress', color: '#3f7fd8' },
        { id: 'planned', name: 'Planned', color: '#8a6fd1' },
        { id: 'considering', name: 'Considering', color: '#8b8578' },
      ],
    } as never,
  })
  const team = await svc.databases.addProperty(tx, workspaceId, database.id, {
    name: 'Team',
    type: 'text',
  })
  const quarter = await svc.databases.addProperty(tx, workspaceId, database.id, {
    name: 'Quarter',
    type: 'text',
  })

  let afterId: string | null = null
  for (const row of ROADMAP_ROWS) {
    const child = await svc.pages.create(tx, actor, workspaceId, {
      spaceId,
      parentId: page.id,
      title: row.title,
      kind: 'page',
      icon: null,
      afterId,
    })
    afterId = child.id
    await svc.databases.setRowFields(tx, workspaceId, child.id, database.id, {
      [status.key]: row.status,
      [team.key]: row.team,
      [quarter.key]: row.quarter,
    })
  }
  return ROADMAP_ROWS.length
}

/**
 * The three steps that put a document into a page — the same ones `templates.ts` performs, written
 * out here rather than imported because that helper is private to the templates service.
 */
async function writeBody(tx: Tx, ctx: DemoSeedContext, pageId: string, body: PageDoc): Promise<void> {
  const { kernel, workspaceId } = ctx
  if ((body.content ?? []).length === 0) return
  const state = pageDocToYState(body)
  await kernel.call('collab.document.replace', {
    name: documentNameOf({ workspaceId, id: pageId }),
    state: state.toString('base64'),
  })
  await tx
    .update(pages)
    .set({ text: textFromPageDoc(body) })
    .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, pageId)))
}
