---
'@kernhq/module-quire': minor
---

Publish a page, and everything nested under it, to a URL a signed-out stranger can open.

Twelve procedures: six behind `quire.page.publish` that create and manage a publication, and six
with no principal at all — `public.site`, `.page`, `.search`, `.sitemap`, `.robots`, `.unlock` —
mounted under `/api/quire/public/{workspaceId}/{slug}`. One migration, `0008`: the `publications`
table, `pages.excluded_from_public`, `page_versions.html`, three indexes and the RLS triple. Sixty-five
new keys in all five locales.

**How an anonymous read reaches a tenant table, decided rather than discovered.** A public endpoint
is the only surface in Kern with no principal behind it, and every table here is fenced by
`current_setting('app.workspace_id')`, which a session sets *from* the principal. So one of three
things had to be true, and the failure in the middle does not look like a bug: somebody notices the
policy matches nothing, writes the public query without a workspace, and it returns every row in
every tenant — the page renders, the content is real, and it belongs to a customer who never
published it. Kern takes the third: *anonymous* means no principal, not no tenant. The URL is
workspace-qualified, the handler resolves that segment against `core` and calls `withWorkspace(id, …)`
before touching `mod_quire` at all, and from there the policy is the plain workspace policy every
other table has. Nothing about the public path is special at the RLS layer, which is the point — a
surface with no principal is not the place to invent a second isolation mechanism. The degradation is
safe by construction: `withWorkspace(null, …)` sets the GUC to `''`, `workspace_id::text` is a uuid,
so a quire query that arrives with no workspace returns **zero rows**. A broken public path shows an
empty page, never somebody else's. Proven against a scratch database as a `nobypassrls` role, because
the dev and CI Postgres role is a superuser and a test that does not drop that proves nothing.

Two rules are written into the migration as non-optional. **Do not widen that policy with an
anonymous clause** — `DELETE` is governed by `USING` alone, so any clause making a row visible
without a workspace makes it deletable without one, and the asymmetry hides behind `INSERT` and
`UPDATE`, which `WITH CHECK` does cover. And **the public path runs `set transaction read only`**:
once the workspace is set, RLS has stopped being a fence around the request, and 25006 is a refusal
from Postgres rather than from a code review. The test asserts the 25006, rather than the comment
asserting the intent.

**Workspace scope is not publication scope**, so every public query carries the publication in its
own `WHERE`. The walk is one recursive CTE rooted at `publications.root_page_id` that *prunes* rather
than filters: it descends only through pages that are themselves a `page`, published, not opted out,
not archived, not trashed. A child of an opted-out parent is therefore unreachable even though it
sits inside the subtree — filtering would have shown it.

**The per-page opt-out is a column on the page, not a join table.** An exclusion row is written
against *one* publication, so publishing a new root above the page later re-exposes it silently, to
somebody who never saw an opt-out belonging to a different row. A column means "never public", holds
against publications that do not exist yet, and the walk reads it from the row it already has instead
of remembering an anti-join on the one surface where a forgotten join is a leak. What it costs is
per-publication precision, and a table can be added beside it later.

**The public surface emits no uuid.** A page's address is a path built from its title — Unicode
letters, so a Persian title keeps a Persian slug, siblings disambiguated by position — and there is
no page, space, version, publication, workspace or user id anywhere in a response. Rendered HTML is
scrubbed on the way out: mentions of pages inside the publication are re-pointed at their public
path, mentions of private pages lose their `href`, and every `id`/`data-id` attribute is stripped,
because a user mention's `data-id` is a person. The cache validator is `sha256(versionId)` rather
than the version id, which addresses `versions.get`, which asks a permission.

**A password grant is a capability token, not a session.** `public.unlock` returns the expiry sealed
with `kernel.secrets.encrypt`, AAD-bound to that one publication, twelve hours, carrying no identity;
the server stores nothing and the route layer is expected to keep it in an HttpOnly cookie rather
than in a link. Passwords are scrypt in a PHC string via `node:crypto` — no new dependency, so no
lockfile to refresh.

**The dialog measures rather than claims.** After publishing it calls the signed-out `public.site` —
the same procedure the internet calls, with the principal replaced server-side — and reports how many
pages a stranger actually sees, or that they are asked for a password, or that they cannot open it at
all. A root nobody ever published produces a live URL and an empty site, and from the inside that
looks exactly like success. The consequence sits above the button before it is pressed and stays
after: anyone with the link, without signing in, this page and everything under it; readers get the
last published version, never the draft.

**Three things the tests caught, and one that is still wrong.** `published_at` arrives from
`tx.execute` as a string, so `.getTime()` was a `TypeError` on every public read while 117 authz
assertions passed — that sweep compares what two callers got, and both got the same crash. `''` and
`NULL` in `page_versions.html` mean rendered-to-nothing and never-rendered, and `if (!row.html)` was
404ing a valid page. `isModuleEnabled` is cached with a TTL, so the "module switched off" test
asserted nothing until it invalidated. Still wrong: the header's "Public" chip is gated on
`quire.page.publish`, because `publications.list` asks for it — so a plain reader gets no indicator
that the page they are looking at is on the internet. That is the wrong way round, and it needs a
procedure that answers "is this page public" without asking to publish it.

Forty-six new integration tests against real Postgres, and the authz sweep is at 118. The guards were
mutation-tested rather than reviewed: dropping `excluded_from_public` from the recursive arm fails
seven of them, and putting a page id into a navigation title fails the sweep by name.

**The address is `/p/{workspaceSlug}/{slug}`, and nothing serves it yet.** The server deliberately
owns no address — `basePath` is an argument, so one instance can serve a site under a prefix and
another under its own domain — which left the client to decide, and `/p/` is a static first segment
because shell's top-level route is `[ws]`: `/{workspace}/p/…` would be inside the signed-in app,
behind its guard. Until the shell route lands, the link the dialog copies is correct and 404s.
