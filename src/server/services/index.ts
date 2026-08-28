import type { JobDef, Kernel } from '@kernhq/kernel'
import { z } from 'zod'
import { quireAccess } from './access.js'
import { quireComments } from './comments.js'
import { quireDatabases } from './databases.js'
import { quireExport } from './export.js'
import { quireImport } from './import.js'
import { quireMacros } from './macros.js'
import { quireOrganisation } from './organisation.js'
import { quirePages } from './pages.js'
import { quirePublications } from './publications.js'
import { quireSpaces } from './spaces.js'
import { quireTemplates } from './templates.js'
import { quireVersions } from './versions.js'

export interface QuireServices {
  access: ReturnType<typeof quireAccess>
  spaces: ReturnType<typeof quireSpaces>
  pages: ReturnType<typeof quirePages>
  versions: ReturnType<typeof quireVersions>
  comments: ReturnType<typeof quireComments>
  databases: ReturnType<typeof quireDatabases>
  organisation: ReturnType<typeof quireOrganisation>
  publications: ReturnType<typeof quirePublications>
  exports: ReturnType<typeof quireExport>
  imports: ReturnType<typeof quireImport>
  templates: ReturnType<typeof quireTemplates>
  macros: ReturnType<typeof quireMacros>
}

const cache = new WeakMap<Kernel, QuireServices>()

/** One set of services per kernel: they are stateless, and rebuilding them per request is waste. */
export function quireServices(kernel: Kernel): QuireServices {
  const existing = cache.get(kernel)
  if (existing) return existing
  const access = quireAccess(kernel)
  const versions = quireVersions(kernel, access)
  // An import writes pages *and* databases, so it is the one service built on another one: it needs
  // `databases` to mint the properties whose keys its rows are keyed by. See `import.ts`'s `write`.
  const databases = quireDatabases(kernel, access)
  /*
   * Templates make pages and spaces, so they are built on the two services that already know how —
   * a second implementation of "create a page" would be a second fractional-index algorithm, and two
   * orderings of one tree is a sidebar that disagrees with itself.
   */
  const spaces = quireSpaces(access)
  const pages = quirePages(access)
  /*
   * Built before `publications`, which needs it: a published page's HTML is rendered on the public
   * path, and a macro inside it has to resolve there too — against the publication rather than
   * against a reader, because on that path there is no reader at all.
   */
  const macros = quireMacros(kernel, access)
  const services: QuireServices = {
    access,
    spaces,
    pages,
    versions,
    comments: quireComments(access),
    databases,
    organisation: quireOrganisation(access),
    publications: quirePublications(kernel, access, versions, macros),
    exports: quireExport(kernel, access),
    imports: quireImport(kernel, access, databases),
    templates: quireTemplates(kernel, access, pages, spaces),
    /*
     * Macros resolve *reads* against whoever is reading, so this service has `access` and nothing
     * that writes. It is deliberately not built on `pages`: a macro must never reach a procedure
     * that answers for the caller rather than for the reader.
     */
    macros,
  }
  cache.set(kernel, services)
  return services
}

/**
 * The background work this module hands to a worker process, gathered here rather than in
 * `index.ts`.
 *
 * One line in the module definition, so adding a job is an edit to this file and not to the file
 * every other part of the module is also editing. The names reach pg-boss as `quire.<name>` — the
 * kernel prefixes them — and only a process started with a worker role runs them; an API process
 * registers nothing and merely sends.
 *
 * `retryLimit` is deliberately small. An export that fails for a reason of its own — Gotenberg is
 * not running, a page will not render — records that reason on its row and returns *successfully*,
 * because it has finished: it failed, and it said so, and repeating it would only write the same
 * sentence three more times. A throw out of the handler means something underneath went wrong
 * (the database, the broker), which is the case a retry is for.
 */
export const quireJobs: JobDef<{ workspaceId: string; jobId: string }>[] = [
  {
    name: 'export',
    schema: z.object({ workspaceId: z.uuid(), jobId: z.uuid() }),
    handler: async (input, { kernel }) => {
      await quireServices(kernel).exports.run(input.workspaceId, input.jobId)
    },
    options: { retryLimit: 2, retryDelay: 30, expireInSeconds: 900 },
  },
  /**
   * An import, with **no retries at all** — the one place in this module where that is the safe
   * setting rather than the timid one.
   *
   * `run` is idempotent against its own row (`done` and `failed` are terminal, and it claims the row
   * before it does anything), so a retry after a *completed* run is a no-op. What a retry cannot be
   * safe against is the case pg-boss actually retries: a handler that threw. An import commits its
   * pages and its finished row in one transaction, so a throw means nothing was written — but a
   * *lost connection after the commit* looks exactly the same from here, and running it again would
   * write every page in the archive a second time. Two hundred duplicate pages in somebody's space
   * is a worse outcome than a job that says it failed and can be started again by a person who can
   * see what is in the space.
   *
   * The window is longer than an export's for the obvious reason: reading a few hundred megabytes of
   * zip and writing four thousand rows is not a fifteen-minute job on a busy instance.
   */
  {
    name: 'import',
    schema: z.object({ workspaceId: z.uuid(), jobId: z.uuid() }),
    handler: async (input, { kernel }) => {
      await quireServices(kernel).imports.run(input.workspaceId, input.jobId)
    },
    options: { retryLimit: 0, expireInSeconds: 3600 },
  },
]

export * from './access.js'
export * from './comments.js'
export * from './databases.js'
export * from './export.js'
export * from './import.js'
export * from './macros.js'
export * from './organisation.js'
export * from './pages.js'
export * from './publications.js'
/** The public surface resolves a workspace slug before anything touches the schema. */
export { resolveWorkspaceSegment } from './publications.js'
export * from './spaces.js'
export * from './templates.js'
export * from './versions.js'
