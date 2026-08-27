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
 * The workspace is named by **slug, not id**. Both are equally public — the id is already in the
 * API path this resolves to — but one of them is a uuid, and a customer publishing a handbook is
 * publishing a URL they will print. Resolving the slug is one lookup the route layer already does
 * for every other page in the product.
 */
export const PUBLIC_SITE_PREFIX = 'p'

export interface PublicSiteAddress {
  /** the workspace's slug, as it appears in every other Kern URL */
  workspaceSlug: string
  /** the publication's slug */
  slug: string
  /**
   * A page's path *inside* the publication, as `public.site` and `public.page` report it. `''` is
   * the front page, which is the whole of what the share dialog ever shows.
   */
  path?: string
}

/**
 * The `basePath` argument `public.page` validates and builds its inter-page links from.
 *
 * Starts and ends with `/`, unreserved segments only — the contract refuses anything else, and the
 * refusal is the point: `//evil.example/` is a protocol-relative URL wearing the costume of a local
 * path, and a caller who could set it would repoint every link on somebody's published site.
 */
export function publicSiteBasePath({ workspaceSlug, slug }: PublicSiteAddress): string {
  return `/${PUBLIC_SITE_PREFIX}/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(slug)}/`
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
  return `${root}${publicSiteBasePath(address)}${trail}`
}
