import type { core } from '@kernhq/contracts'

/**
 * What Quire can put in somebody's inbox.
 *
 * Declared rather than invented at the call site: the inbox renders a notification from its type,
 * and one that was never declared arrives as a blank row.
 */
export const quireNotificationTypes: core.NotificationTypeDef[] = [
  {
    type: 'quire.mention',
    label: 'Mentioned in a page comment',
    description: 'Somebody named you in a remark on a page',
    defaults: { inapp: true, push: true, email: false },
    urgent: false,
  },
]
