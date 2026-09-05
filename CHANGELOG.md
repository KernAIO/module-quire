# @kernhq/module-quire

## 0.17.1

### Patch Changes

- 78fa2b3: Peer `@kernhq/contracts@^0.8.0`, which adds `archivedAt` to `WorkspaceSummary`. A caret on 0.x does
  not cross a minor, so the previous `^0.7.0` could not reach it.

## 0.17.0

### Minor Changes

- 6ab429b: `@` in a comment names somebody, and they are told. The comment composer and its reply box were
  given no mention source, so `RichTextEditor` never installed the mention node and typing `@ada`
  left the characters `@ada` in a sentence — while the server has always read `mention` nodes out of
  a body and raised a `quire.mention` notification for everybody named. A comment that is only a
  mention can now be posted, and the name stays in the line the margin and the notification show.
- b393959: `@` and `+` in a page find something. The wiki editor installed both suggestion menus and supplied
  neither source, so mentioning a person and linking a page each opened a popup reading "Nothing
  matches that" — as did the `/` menu's **Mention someone**, which types an `@`. `@` now offers the
  workspace's members, and `+` the pages of the space, each with the section it lives in so two
  "Overview" pages can be told apart.

### Patch Changes

- 5d5de7b: Peer on `@kernhq/kernel` `^0.10.0`. A caret on 0.x does not cross a minor, so the previous range
  stopped reaching the framework the day 0.10.0 was published — a host installing this module from
  the registry could not resolve a kernel it declares.

## 0.16.4

### Patch Changes

- c115b69: The page picker behind the "embed a page" block has its words: its title, search box, space
  selector and empty state were rendering their message keys, in every language.

## 0.16.3

### Patch Changes

- test(quire): bless the permission matrix and cross-tenant isolation

## 0.16.2

### Patch Changes

- test(quire): tolerate the force-drop FATAL race at scratch-db teardown

## 0.16.1

### Patch Changes

- 632b3db: Declare `@kernhq/ui` as a required peer: the server's page renderer imports `@kernhq/ui/editor/page-doc` and `@kernhq/ui/editor/mermaid`, so a host that does not install `@kernhq/ui` itself — `core` — failed at import with "Cannot find package '@kernhq/ui'" the moment it took 0.16.0.

## 0.16.0

### Minor Changes

- 85a27cd: Diagrams and embeds, and the fetch that fills them.

  A `diagram` block holds Mermaid, Excalidraw or Draw.io **source**, so the page carries it into an
  export, a published site and a print. Mermaid renders server-side; the other two draw their stored
  image and fall back to a link, and a source that will not parse shows the source and the error
  rather than a blank block.

  An `embed` is an unfurl: the server fetching a URL somebody typed, which is the whole reason its
  defences come before its features. Hosts are checked **after** DNS resolution rather than before,
  private, loopback, link-local and unique-local space is refused in v4 and v6, redirects are followed
  by hand and re-checked at every hop, and the body and the clock are both capped. Kern's own objects
  are resolved through `objectTypes`/`resolvers` instead of being fetched at all.

  The Markdown exporter learned all three in the same change. It had cases for neither, and
  `export.int.test.ts` fails when a node the schema can hold has no writer — so a diagram would have
  been dropped silently from every exported file. A diagram writes as a fenced ` ```mermaid ` block,
  which our own importer reads back; an embed and an object write as links, and an object is
  deliberately not resolved, because resolving it would put today's data into yesterday's file with
  the exporter's permissions rather than the reader's.

## 0.15.0

### Minor Changes

- 6688993: Templates, and the eight reading macros.

  **Templates.** A page or a whole space can be saved as one and made again from it, with variables
  filled at creation. Five starters ship with the module — meeting notes, decision record,
  requirements, retrospective, how-to — written as documents somebody would actually use. "New page"
  opens the picker with **Blank page** already focused, so a blank page is still one keystroke away.

  Variables are substituted by walking the document and replacing in text nodes. Never by
  string-replacing the JSON: a value containing a quote would corrupt the page, and that is asserted
  with a value carrying `"`, `{{`, a newline and an emoji.

  **Macros.** `children`, `excerpt`, `excerpt-include`, `include-page`, `recently-updated`,
  `contributors`, `status lozenge` and `expand`, each a node in the page schema _and_ a case in
  `renderPageDoc` — a node the renderer cannot draw is a page that exports, publishes and prints
  blank, and `render.test.ts` holds both halves together.

  Four of the eight read other pages, so they resolve at render time against whoever is reading. On a
  published site there is no reader, so `publications` is given the macro service and resolves them
  against the publication instead — a page outside it, or one with no published version, is not drawn
  rather than drawn as a title.

  Diagrams and embeds are **not** in this change.

## 0.14.0

### Minor Changes

- 654ac0f: Take pages out of Quire as a file, and bring a Notion, Confluence or Markdown export in.

  Six procedures — `exports.start|get|list`, `imports.start|get|list` — two permission keys, one
  migration (`0010`: `export_jobs`, `import_jobs`, four indexes and the RLS triple), two pg-boss jobs,
  two dialogs, a Transfers screen, and 96 new keys in all five locales. Ninety-four integration tests
  across five files, most of them against real Postgres.

  **What actually works, and what does not.** Overstating this is worse than a short list, so:

  - **Export formats.** Markdown and HTML come out as a zip — one folder per page, `index.md` (or
    `index.html`) inside it, that page's pictures in `media/` beside it — for a single page as much as
    for a whole space, because a shape that changes with the content is a filename nobody can predict.
    PDF is one document however much went into it, and needs **Gotenberg**: without it the job fails
    and says so, naming `GOTENBERG_URL` and the address it tried. **Word does not work.** `docx` is in
    the contract and is refused at `start` with a sentence explaining why — `prosemirror-docx`
    serialises a ProseMirror `Node`, which needs a schema that only exists in the browser, and hand-
    written OOXML nothing here can open in Word is a file a customer cannot open rather than a
    refusal an operator can read.
  - **Export scopes.** One page, a page and everything under it, or a whole space, to 5000 pages.
  - **Import sources.** A Notion export zip, a Confluence export, or a plain folder of Markdown, to
    2000 pages and 5000 database rows. A Notion CSV becomes a real Quire database: the column types
    are guessed, and the report says what each guess was and how many values it was made from.
  - **Pictures do not come in.** An `image` node needs a `fileId` that `core.files.get` can answer
    for, and core exposes one file procedure over the broker — `createUpload` needs a _user_
    principal, so a background job cannot mint a file at all. Every picture in an archive therefore
    gets a report row saying it was left out, and its alt text stays in the page where it was. The day
    core grows a procedure that mints a file for a service principal this becomes three lines.
  - **A mention of a person does not survive a round trip.** It is written as `@Ada`, which is what a
    mention reads as everywhere else, and comes back as prose. Carrying the user id in the file would
    make an export identify people and would import a mention of a stranger's id into a workspace that
    never had that person; both are worse than the loss. It is the one construct the writer knows it
    loses, and there is no report row for it, because by then it is a run of text nothing can tell
    from one somebody typed.

  Everything else round-trips: headings, both list kinds with `start`, task lists, tables including
  escaped pipes, code with and without a language, callouts, blockquotes, rules, toggles, hard breaks,
  all seven marks, nesting of each in each — and **internal links in all four directions**, which is
  where a page-to-parent or page-to-sibling link lives.

  **The report is the feature, on the import side.** Every file in the upload gets exactly one row
  saying whether it became a page, was deliberately left out, or could not be read, and
  `counts.total === report.length` — so the counts are a statement about the _upload_ rather than
  about the report. A link naming a file the archive never held gets its own row rather than a note on
  each of the twenty pages that carried it. An import that silently drops forty pages is worse than
  one that refuses, and that is the whole design: an archive that lies about how many files it holds
  is rejected, a file whose checksum does not match fails alone, an entry that inflates past the size
  it declared is refused **without being allocated**, one that honestly declares 50 MB is refused as
  too large for a page, and a `__MACOSX` folder is not a page.

  **An import is one transaction.** Pages, versions, databases and their rows are written together, so
  an archive that fails half way leaves the space exactly as it was — proved against a space that
  already had pages in it, not only against an empty one. It is also why `import` has **no retries**:
  a lost connection after the commit is indistinguishable from a throw before it, and two hundred
  duplicate pages nobody can tell apart is a worse outcome than a job that says it failed.

  **Three things the adversarial passes found, all fixed here rather than filed.**

  `quire.page.export` was checked by the router and never again by the job, so a permission revoked
  while the job sat in the queue did not hold: the worker produced a complete archive of the space and
  `exports.get` signed a link to it. Measured, not reasoned about — `state: 'done'`, five of five
  pages, 911 bytes. The job now re-asks at the scope `start` asked it at, which is what the import half
  already did.

  A transfer's progress was announced with `kernel.realtime.change`, which publishes to the workspace
  channel — and the gateway joins every socket to its workspace at `hello` with no per-message filter.
  That handed every member of the workspace the fact that a named colleague had started an export, and
  when, which is exactly what `exports.get` answers NOT*FOUND rather than FORBIDDEN to avoid
  confirming. It goes to the requester's own subject now. The \_space* still goes to everyone when an
  import lands in it, because pages arriving in a shared space is news for the sidebar; which job put
  them there is not.

  `run` claimed its row by reading it and then updating it, which is a lost update under READ
  COMMITTED — and pg-boss re-dispatches a job that outlives `expireInSeconds` whether or not the first
  attempt is still going. Two attempts of one export each wrote an artefact under a fresh uuid, the row
  named one of them, and `sweep` could never reach the other. Two attempts of one _import_ wrote every
  page in the archive twice. The claim is one conditional `UPDATE … WHERE state = 'queued'` now. What
  that costs is stated rather than hidden: a row whose worker died stays `running` until it is given up
  on after two hours, instead of being re-run.

  **A job that lost its worker ends, which nothing in the module or the kernel could do before.**
  `kernel.jobs` registers a handler and no dead-letter callback, so pg-boss giving up reached pg-boss
  and stopped there — a killed worker left `running` for ever, a list that reported "Running" for ever
  and a dialog that spun with `aria-busy="true"` for ever. Verified with a real worker and a SIGKILL.
  Both services now fail an unfinished row older than two hours, from `start`, `list` **and** `get` —
  the dialog polls `get` and never the list, so a reaper beside the list alone would never reach the
  row somebody is actually looking at.

  **An export artefact is the module's own object and the module deletes it.** It is not a workspace
  file: it does not appear in the file list, is not counted against `storageBytes`, is addressed only
  by the row that knows about it, is fenced to the person who asked (`exports.list` filters on
  `requested_by`; somebody else's id is NOT_FOUND, not FORBIDDEN), and is swept after seven days. The
  download is a fifteen-minute signed URL minted per request, so the permission is checked at the
  moment of the fetch rather than an hour earlier.

  `quire.page.export` is owner, admin and member — a guest is invited to read one thing, not to keep a
  copy of the section around it. `quire.page.import` is owner and admin, and is `dangerous`.

  **Two loose ends worth knowing about.** A CommonMark deviation in the Markdown reader is fixed on the
  way past — a closing `#` run must be preceded by a space, so `# Sharp C#` keeps its hash, on
  hand-written files as much as on ours. And nothing schedules the sweep or the reaper: both run inside
  whichever request happens to be open, because every table here is under FORCE row-level security
  keyed on `app.workspace_id` and a cron job has no workspace to scan with. A workspace nobody comes
  back to keeps its artefacts until somebody does.

## 0.13.1

### Patch Changes

- 6361c85: A public URL resolves the workspace slug it is actually written with.

  The share dialog copies `/p/<workspace-slug>/<publication-slug>/` — a uuid in a link somebody sends
  a colleague is a receipt, not an address — but every `public.*` procedure took a `z.uuid()` and the
  anonymous middleware rejected anything else before a handler ran. So the module answered **404 for
  its own published URLs**, while the identical site served perfectly under the workspace id. Measured
  signed-out against a live stack: id 200, slug 404.

  The segment is resolved at the anonymous entry point, and resolving it here rather than in `core` is
  what stops it becoming an oracle: core could only answer "is there a workspace called this", which
  is a fact about private workspaces too. Here a slug naming a workspace with no such publication
  reaches exactly the same `NOT_FOUND` as a slug nobody has taken — verified for both.

## 0.13.0

### Minor Changes

- f86c8ce: Keep storage keys, and an existence oracle, off the published surface.

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

## 0.12.0

### Minor Changes

- 5425314: Publish a page, and everything nested under it, to a URL a signed-out stranger can open.

  Twelve procedures: six behind `quire.page.publish` that create and manage a publication, and six
  with no principal at all — `public.site`, `.page`, `.search`, `.sitemap`, `.robots`, `.unlock` —
  mounted under `/api/quire/public/{workspaceId}/{slug}`. One migration, `0008`: the `publications`
  table, `pages.excluded_from_public`, `page_versions.html`, three indexes and the RLS triple. Sixty-five
  new keys in all five locales.

  **How an anonymous read reaches a tenant table, decided rather than discovered.** A public endpoint
  is the only surface in Kern with no principal behind it, and every table here is fenced by
  `current_setting('app.workspace_id')`, which a session sets _from_ the principal. So one of three
  things had to be true, and the failure in the middle does not look like a bug: somebody notices the
  policy matches nothing, writes the public query without a workspace, and it returns every row in
  every tenant — the page renders, the content is real, and it belongs to a customer who never
  published it. Kern takes the third: _anonymous_ means no principal, not no tenant. The URL is
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
  own `WHERE`. The walk is one recursive CTE rooted at `publications.root_page_id` that _prunes_ rather
  than filters: it descends only through pages that are themselves a `page`, published, not opted out,
  not archived, not trashed. A child of an opted-out parent is therefore unreachable even though it
  sits inside the subtree — filtering would have shown it.

  **The per-page opt-out is a column on the page, not a join table.** An exclusion row is written
  against _one_ publication, so publishing a new root above the page later re-exposes it silently, to
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

## 0.11.1

### Patch Changes

- 0f515ad: A page title saves as you type, not only when you leave the field.

  It saved on `blur` and nothing else, so typing a name and then going somewhere without blurring
  first — a keyboard shortcut, ⌘K, closing the tab, any programmatic navigation — threw the name away
  and left the page called "Untitled" for ever. Measured against a live stack: fifteen seconds after
  typing, `mod_quire.pages.title` was still `''`, and became the typed value only on blur. Every page
  in the test workspace was called "Untitled" for this reason.

  The body never had the problem, because it is a Y.Doc the collab service persists on its own
  schedule; the title is a plain column behind `pages.update`, so the schedule had to be written.
  `docs/adr/0006` says the title belongs in the Y.Doc beside the body — for this reason and because
  two people renaming at once still clobber each other — and this is not a substitute for that.

## 0.11.0

### Minor Changes

- e7a9aff: Give a wiki the things that make one findable: favourites, recents, labels, watchers and a trash
  you can look in.

  **The trash screen.** "Move to trash" took a page and every page under it, with no confirmation and
  nowhere to look afterwards — deleting "Working here" silently took "Your first week" and "Time off"
  with it, and the only trace was that they had stopped being in the sidebar. `pages.trash` had always
  listed what was taken; nothing drew it. The screen groups the flat listing back into subtrees,
  because restore and purge both act on a subtree and offering to restore three rows separately is the
  same confusion pointed the other way. The confirmation before it counts what is about to go, and the
  toast after it offers the way back.

  **Favourites and recents** are one person's own list, which is a `user_id` in each query rather than
  a permission — RLS fences the workspace, and the workspace is the tenant boundary, not a privacy
  one. Favourites are ordered by a fractional rank so they can be moved without renumbering the list,
  and the column is `COLLATE "C"` for the reason `0006` gave: a base-62 rank sorted by language puts
  the second entry in front of the first.

  **Labels** belong to a space, not to a page — renaming "Draft" changes what it means everywhere it
  is worn, so writing one is `space.manage` while reading is `space.view`. `pages.setLabels` replaces
  the set rather than adding to it, because a picker with one label ticked means the other two are
  gone, and an additive procedure cannot say that without a second one to disagree with.

  **Watchers** answer "am I watching" and "who else is" in one call, because the control draws both
  and asking twice within a keystroke is two requests for one button.

  Twelve new procedures, five new tables in `0007` — each with `workspace_id`, forced RLS and a policy
  — and every string in all five locales.

  **What review found, and this ships fixed.**

  - The trash confirmation stated a **stale** page count while its query was in flight, and the danger
    button was live the whole time: trash a page, press Undo, reopen the dialog and it offered the
    singular sentence for a three-page subtree. `refreshAfterMoving` poisons that cache itself, by
    refetching the tree while the subtree is still in the trash. The count now refuses to read a
    fetch in flight, and the confirm is `aria-busy` and guarded until it has one — never `disabled`,
    which would throw the focus of whoever is standing on it.
  - `pages.trash` named every trashed page to anybody who could reach the screen. The procedure is
    space-scoped, so a page-scoped DENY — the narrow case the permission model exists for — still had
    its title read out. The row was inert as well as private: `pages.get`, `pages.restore` and
    `pages.purge` all refuse it. The listing filters per page now, the same rule `favorites.list`
    follows, and `authz.int.test.ts` holds it there.
  - The trash row's "deleted" tooltip hung a raw `2026-08-25T19:45:47.634Z` off a cell that had just
    said پریروز — through `formatDateTime` now, the same defect the date column had one layer up.
  - The label-filter banner used a physical `padding: 6px 6px 6px 10px`, so in Persian and Arabic the
    room meant for the sentence went to the button beside it.
  - At 390px the trash table's page column collapsed to nothing: `minmax(0, …)` shrinks to zero rather
    than overflowing, so the row drew an icon and "with 1 page inside it" and no title, and the scroll
    box had nothing to scroll. The two text columns have a floor now.
  - `TENANT_TABLES` was read by nothing, and the migration suite could not see a tenant table with no
    policy at all — a `group by` over `pg_policies` simply omits it. Both directions are checked now,
    along with the journal's timestamps, which drizzle silently skips a migration for when they go
    backwards.

## 0.10.9

### Patch Changes

- 6fe280c: The page title draws no focus ring.

  It is the page's heading, not a form field — the caret says where you are. `outline: none` was not
  enough on its own, because the design system's global `:focus-visible` rule draws a `box-shadow`,
  which is a different property: clicking into the title put a box around it.

## 0.10.8

### Patch Changes

- d9a278f: A date column reads in the interface language, not the browser's.

  A native `<input type="date">` draws its value in the **browser's** locale and nothing can restyle
  that. The cell was left permanently in edit mode, so a Persian table showed `08/21/2026` in Latin
  digits — beside a Days column already counting `۱ ۲ ۳`, which is what made it obvious. It also
  painted `mm/dd/yyyy` into every empty date cell and a picker icon into every filled one.

  The cell now reads through `formatDate`, which it already imported and whose comment already said
  this was the intent; the native picker appears when somebody goes to change the date, and focus
  moves into it and back out again so a keyboard never lands on something it cannot see. English
  reads `Aug 21, 2026`; Persian reads `۳۰ مرداد ۱۴۰۵`.

## 0.10.7

### Patch Changes

- 632238a: A disclosure the sidebar opened for you can be closed again.

  The effect that opens an open page's ancestors read `expanded` and wrote it, so it was its own
  trigger: collapsing an ancestor removed it from the set, the effect put it straight back, and the
  control was inert to click and to Enter alike. `expanded` is read through `untrack` now — what
  selects the effect is which page is open and what the tree holds; whether a disclosure is open is
  the result, and a result must not be an input.

  Latent until `navigation.params.page` started arriving (`@kernhq/ui` 0.12 and shell's
  `setRouteParams`). With `activePageId` permanently null the loop never ran, so the fix that told the
  sidebar where it was is what made this reachable — which is the ordinary shape of a regression:
  nothing here changed, something upstream stopped lying.

## 0.10.6

### Patch Changes

- 8def0df: Stop drawing a nameless avatar on a page whose author cannot be resolved, and give the demo's pages
  an author so the byline's named wording is the one it renders.

## 0.10.5

### Patch Changes

- 4b45917: Seed the mock with versions, comments and a page carrying an unpublished draft.

  Version history and the comment margin are two of the three things a page screen is for, and the
  demo interface had neither: the history sheet answered "The history could not be loaded" and no
  margin was ever drawn. That is the environment used for demos _and_ for the shell's end-to-end
  tests, so nineteen of them were failing against the published module for want of data rather than
  for want of behaviour.

  Two pages differ on purpose, so a page with a margin and a page without one are both reachable, and
  one page carries `hasUnpublishedChanges` so the banner above the body can be seen at all. The author
  ids are written out rather than derived — this package cannot see the shell's mock, and a comment
  with nobody's id on it silently loses the delete control that only its author is offered.

## 0.10.4

### Patch Changes

- 6eb986d: Three things the interface was not saying.

  **The main writing surface had no name.** `CollaborativeEditor` carries `role="textbox"`, and a
  textbox with no accessible name is announced as nothing at all — the wiki's editor read as "edit
  text, multi-line". It takes the page's title now (`@kernhq/ui` 0.12 added the prop).

  **The byline never said who.** It drew `<Avatar id={doc.updatedBy} />` with no name — a "?" square
  with an empty accessible name — over the words "Edited 1h ago", so the one line whose job is to say
  who touched this page said everything except that.

  **A space with no home page was called empty.** `SpacePage` branched on `homepageId` alone, so
  opening a space that had never had one showed "This space has no pages — create the first page"
  while the sidebar beside it listed them. It opens the first top-level page instead, and the empty
  state is kept for the space that is actually empty.

## 0.10.3

### Patch Changes

- 1a694a6: Declare the framework this is built against: `@kernhq/contracts@0.7.0`.

  `^0.6.1` cannot install 0.7.0 — a caret on 0.x never crosses a minor — so a host resolving this
  module from the registry would be told it needs a contracts two releases behind the one every
  service now runs. Typechecked against 0.7.0 in the workspace before the range moved, which is the
  only order that means anything: the umbrella pins contracts to `workspace:*`, so raising a range
  first and compiling second compiles against the old copy and proves nothing.

  The lockfile is refreshed in the same change, because `--frozen-lockfile` compares specifiers and
  a range edit alone fails install before anything is built.

## 0.10.2

### Patch Changes

- fix(quire): make every screen operable by a screen reader

## 0.10.1

### Patch Changes

- 278e061: Close two holes in the static renderer, now that something calls it.

  `safeHref` rejected `//evil.example` and accepted `/\evil.example`, which is the same URL: for a
  special scheme the URL parser folds a backslash into a forward slash before the authority, so the
  second one resolves to `https://evil.example` too. Backslashes are now folded before the check —
  up to the first `?` or `#`, which is exactly as far as a browser folds them — so the check reads the
  URL the browser will act on. A backslash in a query or a fragment is left alone.

  `renderNode` and `renderMarks` indexed an object literal with a type name out of the document, so a
  node called `__proto__` (or `constructor`, or `toString`) found something inherited and truthy that
  was not a renderer, and calling it threw `TypeError: render is not a function` — a 500 out of
  `versions.get`, where the rule is that an unrecognised node degrades to its children. Both lookups
  now require an own property.

  Neither was reachable until the version preview gave `renderPageDoc` its first caller.

  The authz sweep also gained a second pass. The first denies at space scope, which a space check and
  a page check both catch, so it proved each procedure's permission key and nothing about its `check`
  column — downgrading the page check to a space check left it green. The new pass denies at object
  scope on the pages themselves, which only a page-level check can see, and covers all 34 procedures
  declaring `check: 'page'`.

- 253f36a: Reach the published framework, and refresh the lockfile that the range edit invalidated.

  `^0.9.0` cannot install `@kernhq/ui@0.10.0` — a caret on 0.x never crosses a minor — so a consumer
  installing this module from the registry resolved a framework it was not built against. Raising the
  range then leaves the committed `pnpm-lock.yaml` out of date with the manifest, and
  `--frozen-lockfile` compares specifiers, so the next publish dies at install having built nothing.
  Both halves are here because one without the other is not a fix.

  `scripts/check-ranges.mjs` now checks the lockfile as well, so the second half cannot be forgotten
  again — and checks this package's hosts against its peers, which `pnpm install` does not: pnpm 10
  resolved a `^0.6.1` peer against `contracts@0.5.2` and exited 0 without a warning.

## 0.10.0

### Minor Changes

- 41208ea: Show what an old version of a page actually said.

  `renderPageDoc` — the only thing outside a browser that can draw a Kern page — was reachable from
  nowhere. It was not re-exported from `src/server/index.ts`, so `@kernhq/module-quire/server` did not
  carry it, and the whole repository mentioned it only in its own definition and its own test.
  Meanwhile version history showed 160 characters of flattened text, which tells you a version exists
  and nothing about the heading, the table or the paragraph you are looking for — although the bytes
  to draw it have been in `page_versions.state` since the first migration.

  `versions.get` now returns `html` beside `text`: the version as it looked, with its pictures signed
  and its page mentions linked, escaped by the same renderer the tests exercise. Version history has a
  **Preview** on each row that draws it. `renderPageDoc`, `textFromPageDoc`, `referencesIn`,
  `safeHref`, `escapeHtml` and `pageDocFromState` are exported from the `./server` subpath, so
  anything else that has to publish, export or mail a page can reach them too.

### Patch Changes

- 06a6b54: Check the page-scoped permission on every `databases.*` and `comments.*` procedure.

  Eight `databases.*` procedures — `get`, `addProperty`, `updateProperty`, `moveProperty`,
  `removeProperty`, `addView`, `updateView`, `removeView` — and three `comments.*` ones — `update`,
  `remove`, `resolve` — asked only the workspace-level question that `requires()` asks. Quire's
  permissions are declared at **space** scope, so the answer that matters comes from a space- or
  page-scoped binding, and `requires()` never looks at one: an ordinary member carrying a space-scoped
  DENY for `quire.page.view|edit` could still read a database's schema and add, rename, reorder and
  delete its columns and views, and settle any thread in the space.

  Each of them now resolves the page it is really acting on — a database's host page, a row's own
  page, a comment's page — and asks `requirePage` with the permission the work needs. Nothing about
  what a permitted caller can do changes.

  `quireProcedureAuthz` in the contract declares, per procedure, what that in-handler check must be,
  because counting middlewares is what let this through: `requires()` was present on all eleven.
  `module.test.ts` holds that map to the contract in both directions, and `authz.int.test.ts` calls
  every procedure against a real Postgres with one permission denied at space scope and asserts each
  refuses — so a procedure added later without a check fails the day it is declared.

- c6c4feb: Make every migration survive being applied twice.

  `create policy`, `create table` and `create index` have no `if not exists`, so a replay throws —
  and a module migration that throws takes down the **whole host service**, not just its own module.
  `core` hosts five. A replay is not hypothetical: drizzle keys applied migrations by content hash, so
  regenerating the journal makes every file run again against a schema that already has its objects.

  0001 created its two policies unguarded and 0000 created its tables and indexes unguarded. Both are
  guarded now, and `src/server/migrations.test.ts` applies the whole set twice and asserts one policy
  per table — the existing idempotence assertion could not catch this, because it calls
  `migrateModule` twice and the second call reads `__migrations`, sees the work is done and returns.

## 0.9.3

### Patch Changes

- fix(quire): say why a rollup cannot pick a column yet

## 0.9.2

### Patch Changes

- 26417b7: Stop using `t('common.*')` in this module's screens.

  `@kernhq/ui` declares `sideEffects: ["**/*.css"]`, so a bundler drops
  `common-messages.js` — whose only job is a top-level `registerMessages` call — out of every
  production build. `t('common.cancel')` therefore renders the literal key in a built app and the
  right word in dev, which is why it survived: the confirmation dialog that deletes a view shipped
  with buttons reading `common.cancel` and `common.delete`.

  Quire now carries its own eight shared words. Collapse them back into `common.*` once the framework
  marks that module as having side effects.

## 0.9.1

### Patch Changes

- test(quire): anchor the database views for the end-to-end sweep

## 0.9.0

### Minor Changes

- ea7b381: Give the database engine an interface, and fix six things it could not have been built on.

  **The interface.** A `database` page now renders view tabs, a toolbar and the view itself instead of
  the editor. Table with inline editing per property type, column resize and reorder, row hover
  actions and a row inspector panel; board grouped by a select, status or tick column with drag
  between lanes and a keyboard equivalent on every card; gallery, list and calendar. A property editor
  (add, rename, retype, configure, hide, delete) and a view editor (filters, sorts, grouping, date
  column, visible columns, card size). Every string in all five locales, RTL-safe and dark-mode-safe.

  **New procedures.** `databases.forPage` — a page carries no field pointing at the database it _is_,
  because `pages.database_id` already means "row of". `databases.list` — a relation column has to name
  another database, and nothing listed them. `databases.lookup` — a relation cell holds page ids, so
  without it the column draws uuids. `databases.moveProperty` — the service accepted a position and
  the contract never exposed one, so a column could not be reordered through the published API.

  **Fixes.**

  - Filters and sorts on `formula`, `rollup`, `created_time`, `created_by`, `edited_time` and
    `edited_by` read `props`, where none of those values is ever written. Sorting by a formula
    silently did nothing. There is now one `valueExpr` that knows where each type lives, and its casts
    are guarded — a number column holding pasted text no longer 500s the whole view.
  - `setRelation` wrote only the join table while `Row` exposes only `props`, so a relation column was
    permanently blank and a relation filter never matched. The ids are mirrored into `props` on both
    sides, and `updateRow` routes relation keys through `setRelation` so the two cannot diverge.
  - `rows()` filtered its cursor with `pages.id > cursor` while ordering by the view's sorts, which is
    only a valid keyset when id is the whole ordering — every sorted view dropped and repeated rows.
    It pages by offset now.
  - `removeView` refused to delete a **default** view rather than the **last** one, so the first tab of
    every database could never be deleted. It refuses the last one and promotes a new default.
  - `toView` cast `config` instead of parsing it, so `view.config.filterMode` was `undefined` at
    runtime while its type promised a value.
  - `properties.position` and `views.position` were not `COLLATE "C"`, so the fractional ranks sorted
    by language rather than by code point — a database's second view sorted in front of its first, and
    moving a column put it somewhere nobody asked for. Migration `0006` fixes both; it is additive and
    an older image reads the same rows.

  Rows are also excluded from `pages.tree`: a row is a page parented to its database's page, so a
  database of five hundred rows put five hundred entries in the sidebar. And the seven schema
  mutations that announced nothing now announce `database`, so adding a column reaches a second tab.

  `formula.ts` moved from `src/server` to `src/client` — unchanged, and still imported by the server —
  so the property editor can validate an expression as it is typed. The client only parses; the server
  is still the only thing that evaluates one.

## 0.8.0

### Minor Changes

- 739b736: Render a page outside the browser.

  `renderPageDoc()` turns a page's ProseMirror JSON into sanitised HTML with no DOM, and
  `textFromPageDoc()` flattens the same document to plain text. `pageDocFromState()` is what gives
  them their input: it decodes the Yjs bytes a version already stores, so the server can finally read
  a document it previously could only pass around.

  Every node and mark the wiki editor can produce has a case, and `render.test.ts` asserts that by
  comparing the dispatch tables against `PAGE_DOC_NODES` and `PAGE_DOC_MARKS` from `@kernhq/ui` —
  in both directions, so a block with no renderer fails and so does a renderer for a block that no
  longer exists. Text is escaped, link protocols are limited to http/https/mailto, and a
  protocol-relative `//host` href is rejected rather than treated as local.

  This also fixes the search body. `collab` flattens a document by calling `toString()` on each
  `Y.XmlText`, which renders marks as markup — so a page holding one link indexed
  `rel="noopener noreferrer nofollow"` along with its prose, and every page in the workspace matched
  a search for "noopener". Page rows and version previews now use the real flatten, and fall back to
  what collab published if the document cannot be read.

  A page is written in the wide wiki schema (`page` on `CollaborativeEditor`); comments keep the
  narrow one.

## 0.7.4

### Patch Changes

- fix: declare @kernhq/kernel and @kernhq/contracts as peerDependencies

## 0.7.3

### Patch Changes

- Merge remote-tracking branch 'origin/main'

## 0.7.2

### Patch Changes

- chore: refresh the lockfile for the changesets dependency

## 0.7.1

### Patch Changes

- fix(deps): reach the framework that was just published

## 0.7.0

### Minor Changes

- ea2002d: Quire ships its own screens.

  All three pages, seven components, 75 strings in five locales, the mock and the API instance move
  into this package. The routes are declarations now — `/quire`, `/quire/:space`, `/quire/:space/:page`
  — matched by the shell, which hands the component its `params`. A wiki page's URL is this module's
  business rather than something the app mirrors in its route tree.

  **Two `QUIRE_PERMISSIONS` existed and they disagreed.** This package declared six keys; the app
  declared eight, adding `page.comment` and `page.publish`. Any screen gating through the package's
  copy was reading a key that did not exist there — and a wrong permission string is a perfectly valid
  string, so nothing reported it. There is one now, derived from the contract, and `key()` throws at
  import if a name is not declared.

  Components read the shell's `navigation` singleton instead of `$app/navigation` and `$app/state`,
  and the collaborative editor takes its endpoint from the host instead of naming port 4300.

## 0.6.1

### Patch Changes

- 099995e: Stop the formula AST's `if` node being thenable.

  An object with a `then` property is a thenable: `await` and `Promise.resolve()` call it as a
  promise. The node's `then` was an AST node rather than a function, so the moment one was returned
  from an `async` function the runtime would stop treating it as data — silently, with no error at the
  point of the mistake. Renamed to `consequent`/`alternate`, which is the standard naming anyway.

## 0.6.0

### Minor Changes

- 56a8216: Databases: rows, typed columns, views, relations and rollups.

  A row **is** a page — created in the same space, parented to the database's own page — so it is
  openable, commentable, versioned and searchable without any of that being built twice. Cells live in
  `props`, keyed by a stable `key` rather than by name, so renaming a column keeps its data.

  Filtering and sorting happen in SQL over `jsonb`, not in memory: a page of fifty rows filtered down
  to three is not a page of three, and the caller has no way to ask for the rest. Sorts are typed, so
  10 does not come before 9. An untouched checkbox filters as `false`, because most rows are ones
  nobody has touched. A filter naming a property that does not exist is refused rather than
  interpolated — the key arrives in the request and `props->>'…'` is query text, not a parameter.

  Formulas and rollups are computed on write into `computed`, so a view can sort and filter by one
  like any other column. A broken formula shows an error in its own cell rather than failing the write
  that triggered it.

  Three bugs the tests caught, each of which would have read as "the data is wrong" rather than as a
  bug: the database's own page appeared as the first row of itself, a rollup looked for its target
  column in the database holding the rollup rather than the one across the relation, and every
  camelCase formula function was unreachable.

## 0.5.0

### Minor Changes

- f9849bb: The database foundations: schema, property types and the formula language.

  A database is not a second kind of object beside a page — it _is_ a page whose body renders a view,
  and each of its rows is a page too. That is what makes a row openable, commentable, versioned and
  searchable without building any of it again.

  The formula language is a hand-written Pratt parser to a typed AST, evaluated by walking it.
  **Never `eval`, never `new Function`**: a formula is text a workspace member types and the server
  evaluates, and handing that to the JavaScript engine is arbitrary code execution with the database
  connection already open. The first tests assert what it refuses.

  `&&` and `||` short-circuit, so `false && prop("x")` never reads `x`. Dividing by nothing gives a
  blank cell rather than `Infinity`. Function names are matched case-insensitively — keying the table
  by the lowercased name instead would have made every camelCase function silently unreachable, which
  it did until a test caught it.

## 0.4.1

### Patch Changes

- 3f6b975: Export the comment types from the client, so a margin panel can be typed without reaching into
  `./contract`.

## 0.4.0

### Minor Changes

- 6980c0e: Comments, mentions and search.

  Comments are anchored with **Yjs relative positions**, not character offsets. An offset names a
  place that only exists while nobody else is typing — two words inserted above and the remark is
  attached to something it was never about. `quotedText` is kept alongside so a thread whose text has
  since been deleted still reads as being about something.

  Replying to a reply joins the thread rather than nesting deeper, and resolving settles the
  conversation rather than one remark in it. A thread whose opening comment is deleted keeps its
  replies: they are still somebody's words.

  Mentions notify everyone named except the author, through a best-effort `NotifyService` — a comment
  must not fail to post because core is briefly unavailable.

  Pages are indexed for workspace search, and `resolvers` render a page or space wherever another
  module links to one. **Only pages in an `open` space are indexed**, deliberately:
  `SearchDocument.acl` matches against `[userId, …groupIds, 'role:<role>']`, so indexing a restricted
  space correctly means knowing which subjects may read a page — and core can answer "may this person
  read this object" but cannot enumerate who can. Guessing yields either a private page in a
  stranger's results or a page its author cannot find. The restricted case waits for a core procedure
  that can answer it.

## 0.3.1

### Patch Changes

- 59f0ab4: Export `PageVersion` and `VersionKind` from the client, so a version list can be typed without
  reaching into `./contract`.

## 0.3.0

### Minor Changes

- e76476c: Drafts, publishing and version history.

  `page_versions` is the backbone of both halves of the draft model rather than a feature beside it: a
  **page** serves `published_version_id` to a reader, and a **live doc** serves the document itself —
  one mechanism, two behaviours.

  - `versions.list` / `get` / `create` — history, with the version a reader is being served marked.
  - `versions.restore` — puts an older version back. The state it replaces is captured _first_, so
    restoring is never itself the thing that loses work.
  - `publishing.publish` / `revert` — decide what readers see, or throw the draft away and go back.
    Reverting also keeps what it discarded.

  Restoring and reverting go through `collab.document.replace`, not `apply`: applying an update merges
  it, so an older state would produce the union of old and new and bring every deleted paragraph back
  alongside the ones that replaced it.

  Subscribing to `collab.document.updated` mirrors the flattened prose onto the row, marks a page
  whose draft has moved on from what readers see, and takes an automatic version when the last one is
  old enough — so history accumulates while somebody writes rather than only when they remember to
  press something.

  New permission `quire.page.publish`: deciding what readers and any public site are served is a
  different question from being allowed to write a draft.

## 0.2.1

### Patch Changes

- 7d9765e: Export `pageDocumentName(page)` from the client.

  The name a page's prose is synchronised under is the module's to decide, and the collab gateway
  parses it with the matching function in `@kernhq/contracts`. Leaving the caller to assemble the
  string means a name the gateway cannot parse, which is a rejected WebSocket with no useful error.

## 0.2.0

### Minor Changes

- c4adc88: Quire: spaces and the page tree.

  The first half of the module the collab service has been waiting for. Spaces with a key, an icon and
  a visibility; pages nested to any depth, ordered by a fractional index so two people reordering at
  once never renumber the same rows; move with a cycle guard; archive; a trash that takes the whole
  subtree and brings it all back; and a purge that also tells the collab service to forget the
  document, which nothing else does.

  Permissions are declared at **space** scope, so a binding on a page beats one on its space, which
  beats one on the workspace — which is what makes "everyone may read the Handbook, the design team
  may write it, and this contractor may read one page of it" expressible.

  `quire.collab.access` is implemented against the shapes in `@kernhq/contracts`, so the collab
  gateway's question and this module's answer are the same shape by construction.
