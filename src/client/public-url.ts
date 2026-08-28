/**
 * Where a published site lives, decided in exactly one place.
 *
 * The module's `public.*` procedures deliberately know nothing about this. They answer `path`
 * relative to a publication — `''` for the front page, `guide/install` for a nested one — and take
 * `basePath` as an argument, because one instance may serve a site under this prefix and another
 * under a domain of its own. That is the right call on the server and it leaves somebody having to
 * decide the address, so this file is that somebody: the share dialog shows what it returns, the
 * header link opens it, and whatever route eventually renders a published page has to match it.
 *
 * **`/p/` is a literal segment before the workspace, not after it.** Every other Kern URL starts
 * with the workspace — `/{workspace}/quire/{space}/{page}` — and a published site cannot, because
 * the shell's top-level route is `[ws]`: `/{workspace}/p/…` would be inside the signed-in app,
 * behind its guard, which is the one thing a public URL must not be. A static first segment sorts
 * ahead of a dynamic one in SvelteKit, so `/p/…` is reachable signed out and cannot be shadowed by
 * a workspace. The cost is that a workspace whose slug is exactly `p` would collide, which is why
 * the segment is here as a constant rather than typed out at three call sites.
 *
 * **The workspace is named by id, and it was named by slug until that address stopped resolving.**
 * A slug is the nicer half of the trade — a customer publishing a handbook is publishing a URL they
 * will print — and it is only nicer if it works. Turning a slug into the workspace id the public
 * procedures require is a lookup nothing can do signed out: every workspace read in `core` is
 * behind a membership check, and a published site has no member reading it. So the route layer
 * accepts the id form and refuses everything else, and this dialog was handing customers an address
 * that answered 404 in every deployment that is not the mock — measured by copying the link out of
 * the share dialog and fetching it.
 *
 * The id is not a secret: it is already the first segment of the API path the address resolves to,
 * and it names a tenant rather than anything inside one. When `core` grows a signed-out
 * `workspaces.publicBySlug`, the slug form becomes correct as well and this is the one function
 * that has to change.
 */
export const PUBLIC_SITE_PREFIX = 'p'

export interface PublicSiteAddress {
  /** the workspace's id, which is what the public procedures resolve a tenant by */
  workspaceId: string
  /** the publication's slug */
  slug: string
  /**
   * A page's path *inside* the publication, as `public.site` and `public.page` report it. `''` is
   * the front page, which is the whole of what the share dialog ever shows.
   */
  path?: string
}

/**
 * `/p/<workspace>/<publication>` — **no trailing slash**, both segments already encoded.
 *
 * The route serves the canonical form without one and answers the trailing-slash form with a 308,
 * so a base that ended in `/` put an extra hop into every link a customer printed or pasted.
 *
 * This is not the `basePath` argument `public.page` takes: that one has to start *and* end with a
 * slash, and the route layer builds it from this by adding one.
 */
export function publicSiteBasePath({ workspaceId, slug }: PublicSiteAddress): string {
  return `/${PUBLIC_SITE_PREFIX}/${encodeURIComponent(workspaceId)}/${encodeURIComponent(slug)}`
}

/**
 * The address to show somebody, absolute when there is an origin to be absolute against.
 *
 * `location` is read defensively rather than assumed: this module's client is source, built by the
 * consumer, and a consumer that renders a screen on the server has no `location` at all. A relative
 * address is still correct there — it is only the *copyable* one that has to be absolute.
 */
export function publicSiteUrl(address: PublicSiteAddress, origin?: string): string {
  const root = origin ?? (typeof location === 'undefined' ? '' : location.origin.replace(/\/+$/, ''))
  const trail = (address.path ?? '')
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/')
  const base = `${root}${publicSiteBasePath(address)}`
  return trail ? `${base}/${trail}` : base
}
