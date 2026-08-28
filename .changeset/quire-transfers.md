---
'@kernhq/module-quire': minor
---

Take pages out of Quire as a file, and bring a Notion, Confluence or Markdown export in.

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
  for, and core exposes one file procedure over the broker — `createUpload` needs a *user*
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
`counts.total === report.length` — so the counts are a statement about the *upload* rather than
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
when, which is exactly what `exports.get` answers NOT_FOUND rather than FORBIDDEN to avoid
confirming. It goes to the requester's own subject now. The *space* still goes to everyone when an
import lands in it, because pages arriving in a shared space is news for the sidebar; which job put
them there is not.

`run` claimed its row by reading it and then updating it, which is a lost update under READ
COMMITTED — and pg-boss re-dispatches a job that outlives `expireInSeconds` whether or not the first
attempt is still going. Two attempts of one export each wrote an artefact under a fresh uuid, the row
named one of them, and `sweep` could never reach the other. Two attempts of one *import* wrote every
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
