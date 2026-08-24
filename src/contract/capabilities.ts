import { defineCapabilities } from '@kernhq/contracts'

/**
 * Sub-features a workspace can switch off inside this module.
 *
 * Only the foundation exists today, and it is `required` — always on, never offered as a switch — so
 * that the optional ones arriving later have something to depend on. A capability is not a second
 * permission system: a permission asks whether this *person* may do something, a capability asks
 * whether this *workspace* has the feature at all, and a procedure behind a disabled one answers
 * `notFound` rather than `forbidden`, because a surface the workspace never enabled is not being
 * withheld — it is not there.
 *
 * Planned, each of which is a real "different customers want different amounts of this": databases,
 * public publishing, blogs and page analytics. They are declared when the feature lands, not before:
 * a switch that does nothing is worse than no switch.
 */
export const quireCapabilities = defineCapabilities([
  {
    id: 'pages',
    label: 'Spaces and pages',
    description: 'The page tree itself',
    required: true,
  },
])

/**
 * Which procedures belong to which capability, as data.
 *
 * Declared rather than inferred, because a missing `requiresCapability` is invisible: the procedure
 * type-checks, the tests pass, and the only symptom is that a workspace which switched the feature
 * off can still call it. `module.test.ts` reads this and fails when a procedure named here is not
 * carrying the extra middleware.
 *
 * Everything Quire offers today belongs to the module as a whole, so this is empty.
 */
export const quireCapabilityProcedures: Record<string, readonly string[]> = {}
