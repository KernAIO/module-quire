import { defineClientModule } from '@kernhq/ui'
import { quireMessageBundles, t } from './i18n.js'
import { QUIRE_PERMISSIONS } from './permissions.js'

/**
 * Quire as the shell sees it.
 *
 * The sidebar is a search box and a page tree rather than a "New page" button, because the sidebar
 * belongs to the module you are in and a wiki's sidebar is its table of contents (DESIGN.md §2.3).
 * Creating a page happens where you are standing — at the space, or under the page you are reading.
 *
 * The three routes are declarations now, not files in the app. `:space` and `:page` are matched by
 * the shell and handed to the component as `params`, so a wiki page's URL is this module's business
 * rather than something the app has to mirror in its route tree.
 *
 * Labels are getters because a module is defined once at import time while the interface language
 * can change afterwards; reading them on render keeps the rail in the language actually chosen.
 */
export const quireClientModule = defineClientModule({
  id: 'quire',
  name: 'Quire',
  icon: 'scroll-text',
  messages: quireMessageBundles,

  nav: [
    {
      id: 'quire',
      get label() {
        return t('nav')
      },
      icon: 'scroll-text',
      href: '/quire',
      order: 40,
      permission: QUIRE_PERMISSIONS.spaceView,
    },
  ],

  routes: [
    {
      path: '/quire',
      component: () => import('./pages/SpacesPage.svelte'),
      get title() {
        return t('title')
      },
      permission: QUIRE_PERMISSIONS.spaceView,
    },
    {
      path: '/quire/:space',
      component: () => import('./pages/SpacePage.svelte'),
      permission: QUIRE_PERMISSIONS.spaceView,
    },
    /**
     * Declared before `/quire/:space/:page` for a reader's benefit only — the shell resolves by
     * specificity, not by order, so the two literal segments here beat the one in the page route
     * whatever sequence they are written in. A page whose id happened to be "trash" could not
     * shadow this, and a space could not shadow the spaces index either.
     *
     * `page.edit`, matching what `pages.trash` asks on the server: the trash is where an edit is
     * undone, so anybody who may edit a page in this space may see what has been taken out of it.
     * Purging is `page.delete` and is gated on the row.
     */
    {
      path: '/quire/:space/trash',
      component: () => import('./pages/TrashPage.svelte'),
      get title() {
        return t('trash')
      },
      permission: QUIRE_PERMISSIONS.pageEdit,
    },
    {
      path: '/quire/:space/:page',
      component: () => import('./pages/PageView.svelte'),
      permission: QUIRE_PERMISSIONS.pageView,
    },
  ],

  commands: [
    {
      id: 'quire.open',
      get label() {
        return t('cmd_open')
      },
      icon: 'scroll-text',
      permission: QUIRE_PERMISSIONS.spaceView,
      run: (ctx) => ctx.navigate('/quire'),
    },
    {
      id: 'quire.new-space',
      get label() {
        return t('cmd_new_space')
      },
      icon: 'plus',
      permission: QUIRE_PERMISSIONS.spaceManage,
      run: (ctx) => ctx.navigate('/quire?new=1'),
    },
  ],

  sidebar: [
    {
      id: 'quire',
      match: ['quire'],
      permission: QUIRE_PERMISSIONS.spaceView,
      component: () => import('./components/SidebarSpaces.svelte'),
    },
  ],

  presenters: [
    {
      type: 'page',
      inline: () => import('./components/PageInline.svelte'),
      page: (id, workspaceSlug) => `/${workspaceSlug}/quire/p/${encodeURIComponent(id)}`,
    },
  ],
})

export default quireClientModule
