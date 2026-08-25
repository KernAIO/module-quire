import type { Kernel } from '@kernhq/kernel'
import { quireAccess } from './access.js'
import { quireComments } from './comments.js'
import { quireDatabases } from './databases.js'
import { quirePages } from './pages.js'
import { quireSpaces } from './spaces.js'
import { quireVersions } from './versions.js'

export interface QuireServices {
  access: ReturnType<typeof quireAccess>
  spaces: ReturnType<typeof quireSpaces>
  pages: ReturnType<typeof quirePages>
  versions: ReturnType<typeof quireVersions>
  comments: ReturnType<typeof quireComments>
  databases: ReturnType<typeof quireDatabases>
}

const cache = new WeakMap<Kernel, QuireServices>()

/** One set of services per kernel: they are stateless, and rebuilding them per request is waste. */
export function quireServices(kernel: Kernel): QuireServices {
  const existing = cache.get(kernel)
  if (existing) return existing
  const access = quireAccess(kernel)
  const services: QuireServices = {
    access,
    spaces: quireSpaces(access),
    pages: quirePages(access),
    versions: quireVersions(kernel, access),
    comments: quireComments(access),
    databases: quireDatabases(kernel, access),
  }
  cache.set(kernel, services)
  return services
}

export * from './access.js'
export * from './comments.js'
export * from './databases.js'
export * from './pages.js'
export * from './spaces.js'
export * from './versions.js'
