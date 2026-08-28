import type { Kernel } from '@kernhq/kernel'
import { quireAccess } from './access.js'
import { quireComments } from './comments.js'
import { quireDatabases } from './databases.js'
import { quireOrganisation } from './organisation.js'
import { quirePages } from './pages.js'
import { quirePublications } from './publications.js'
import { quireSpaces } from './spaces.js'
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
}

const cache = new WeakMap<Kernel, QuireServices>()

/** One set of services per kernel: they are stateless, and rebuilding them per request is waste. */
export function quireServices(kernel: Kernel): QuireServices {
  const existing = cache.get(kernel)
  if (existing) return existing
  const access = quireAccess(kernel)
  const versions = quireVersions(kernel, access)
  const services: QuireServices = {
    access,
    spaces: quireSpaces(access),
    pages: quirePages(access),
    versions,
    comments: quireComments(access),
    databases: quireDatabases(kernel, access),
    organisation: quireOrganisation(access),
    publications: quirePublications(kernel, access, versions),
  }
  cache.set(kernel, services)
  return services
}

export * from './access.js'
export * from './comments.js'
export * from './databases.js'
export * from './organisation.js'
export * from './pages.js'
export * from './publications.js'
/** The public surface resolves a workspace slug before anything touches the schema. */
export { resolveWorkspaceSegment } from './publications.js'
export * from './spaces.js'
export * from './versions.js'
