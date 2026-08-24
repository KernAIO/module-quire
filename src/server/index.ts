import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CollabAccess, CollabAccessInput, type Principal } from '@kernhq/contracts'
import { KernError } from '@kernhq/kernel'
import {
  MODULE_ID,
  quireCapabilities,
  quireContract,
  quireEvents,
  quirePermissions,
} from '../contract/index.js'
import { defineModule, defineServerModule, implement_, packageVersion } from './_impl.js'
import { schema } from './schema.js'
import { quireServices } from './services/index.js'

/** These procedures are reachable only from another Kern service, never from a browser. */
function requireService(principal: Principal): void {
  if (principal.kind !== 'service' && !principal.instanceAdmin) throw KernError.forbidden()
}

export const quireModule = defineServerModule({
  definition: defineModule({
    id: MODULE_ID,
    name: 'Quire',
    version: packageVersion(import.meta.url),
    description: 'Spaces, nested pages and documents a team writes together',
    icon: 'book-open',
    permissions: quirePermissions,
    capabilities: quireCapabilities,
    events: quireEvents,
    /**
     * A page is a first-class object elsewhere in Kern: it can be mentioned, linked, searched and —
     * `channelable` — given its own conversation in chat.
     */
    objectTypes: [
      { type: 'page', label: 'Page', icon: 'file-text', channelable: true },
      { type: 'space', label: 'Space', icon: 'book-open' },
    ],
  }),
  /** Attached so the developer panel can check the router against what was promised. */
  contract: quireContract,
  schema,
  migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '../../migrations'),
  router: implement_,

  procedures: {
    /**
     * Whether a user may open a page's collaborative document.
     *
     * This is what the collab gateway calls before it accepts a WebSocket. The shapes come from
     * `@kernhq/contracts` rather than being spelled out here: the gateway falls back to plain
     * workspace membership when a module does not answer, so a signature that does not match fails
     * silently and looks exactly like a module that works.
     */
    'collab.access': {
      input: CollabAccessInput,
      output: CollabAccess,
      handler: async (input, { kernel, principal }) => {
        requireService(principal)
        if (input.type !== 'page') return { canRead: false, canWrite: false }
        const svc = quireServices(kernel)
        return kernel.database.withWorkspace(input.workspaceId, async (tx) => {
          try {
            const scope = await svc.access.scopeOf(tx, input.workspaceId, input.id)
            // The gateway is a service acting for somebody else, so the subject's own memberships
            // have to come from core rather than from the caller.
            const subject =
              principal.userId === input.userId
                ? principal
                : ((await kernel
                    .call<Principal | null>('core.users.principal', { userId: input.userId })
                    .catch(() => null)) ?? {
                    ...principal,
                    userId: input.userId,
                    instanceAdmin: false,
                    kind: 'user' as const,
                  })

            const canRead = await svc.access.canPage(subject, 'quire.page.view', input.workspaceId, scope)
            const canWrite =
              canRead && (await svc.access.canPage(subject, 'quire.page.edit', input.workspaceId, scope))
            return { canRead, canWrite }
          } catch (err) {
            // A page that is missing or forbidden means "no access"; anything else is a real failure
            // and must not be flattened into a silent denial.
            if (err instanceof KernError && (err.code === 'NOT_FOUND' || err.code === 'FORBIDDEN'))
              return { canRead: false, canWrite: false }
            throw err
          }
        })
      },
    },
  },
})

export default quireModule
