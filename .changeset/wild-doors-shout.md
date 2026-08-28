---
'@kernhq/module-quire': minor
---

Keep storage keys, and an existence oracle, off the published surface.

A published page drew its pictures as presigned storage URLs and stored the result, so every
illustrated page handed a signed-out stranger the tenant's workspace uuid and a file uuid —
`ws/<workspaceId>/<module>/<yyyy>/<mm>/<fileId>/<name>` — on the one surface whose rule is that no
answer carries an id, and the same URL expired an hour after publication, so those pictures broke
the afternoon they went out. The stored HTML now carries an opaque reference sealed to the
workspace, and the new `public.asset` procedure answers the bytes for one that is referenced by a
page currently public in that publication. Migration `0009` rewrites the HTML already in the
database, and the read path drops any picture it still cannot account for.

Four handlers had no answer for a publication whose root page had since been trashed: `site` and
`page` refused it, `search` and `sitemap` returned an empty body, and `robots` — written never to
distinguish one slug from another — offered it to crawlers. All five are now indistinguishable from
a slug nobody has taken.

Also: `public.unlock` has a per-publication attempt limit of its own rather than only the
platform-wide budget it shares with every other endpoint; an upper-case workspace id in a public URL
resolves instead of silently matching no row-level-security policy; the share dialog stops claiming
a page is public when the site exists and the page has never been published; and a recent page's
timestamp is legible on the active sidebar row, where it was 2.83:1 in light and 2.50:1 in dark.

Two shapes changed with it. `PublicSiteAddress` names the workspace by `workspaceId` rather than
`workspaceSlug`, because the slug form resolved in the mock and nowhere else — the address the share
dialog copied answered 404 in every real deployment — and `publicSiteBasePath` no longer ends in a
slash, which the route answered with a redirect. Anything rendering a published site must serve
`<basePath>__media/<reference>` from `public.asset`, with `nosniff` and a `default-src 'none'`
policy on the response.
