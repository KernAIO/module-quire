import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * This module's tables, in its own Postgres schema.
 *
 * `pgSchema` directly rather than `moduleSchema` from @kernhq/kernel, so drizzle-kit can load this
 * file standalone — the same reason the tracker does it.
 *
 * Two rules, neither optional:
 *
 * - every tenant table carries `workspace_id` and an index that starts with it;
 * - every tenant table gets a row-level security policy, hand-written in the migration, because
 *   drizzle-kit does not generate one.
 */
export const schema = pgSchema('mod_quire')

/** Yjs state is binary; drizzle has no `bytea`, so it is declared once here. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' })

const jsonObject = (name: string) => jsonb(name).notNull().default(sql`'{}'::jsonb`)
const jsonArray = (name: string) => jsonb(name).notNull().default(sql`'[]'::jsonb`)
const uuidArray = (name: string) => uuid(name).array().notNull().default(sql`'{}'::uuid[]`)

const id = () => uuid('id').primaryKey().default(sql`uuidv7()`)
const ws = () => uuid('workspace_id').notNull()
const ts = (name: string) => timestamp(name, { withTimezone: true })

export const spaces = schema.table(
  'spaces',
  {
    id: id(),
    workspaceId: ws(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon'),
    visibility: text('visibility').notNull().default('open'),
    /**
     * No foreign key to `pages`: the space is created before it can have a home page, and pages
     * point at their space, so a constraint in both directions makes either one impossible to
     * insert first.
     */
    homepageId: uuid('homepage_id'),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    archivedAt: ts('archived_at'),
  },
  (t) => [
    uniqueIndex('spaces_ws_key_uq').on(t.workspaceId, t.key),
    index('spaces_ws_idx').on(t.workspaceId, t.createdAt),
  ],
)

export const pages = schema.table(
  'pages',
  {
    id: id(),
    workspaceId: ws(),
    spaceId: uuid('space_id').notNull(),
    parentId: uuid('parent_id'),
    /**
     * A fractional index as text, not an integer. Moving a page between two siblings must not
     * renumber the rest: two people reordering at once would write different numbers for the same
     * rows, and the tree would disagree with itself until someone reloaded.
     *
     * **The column is `COLLATE "C"` in the migration, and has to stay that way.** The keys are
     * base-62 fractions whose alphabet is ordered by code point, so `ORDER BY position` is only the
     * order the algorithm intended under byte comparison. This database is `en_US.UTF-8`, where
     * `'U' < 'c'` is false — three pages created in order come back reversed. drizzle-kit does not
     * carry the collation in its snapshot, so if you ever regenerate this migration, put it back.
     */
    position: text('position').notNull(),
    kind: text('kind').notNull().default('page'),
    /**
     * Mirrored out of the collaborative document, where the title is a Y.Text so two people renaming
     * at once merge instead of clobbering. This column exists so the tree can be queried and sorted
     * without decoding a CRDT; the document is the truth.
     */
    title: text('title').notNull().default(''),
    icon: text('icon'),
    coverUrl: text('cover_url'),
    /** The version a reader without edit rights is served. Null until a `page` is first published. */
    publishedVersionId: uuid('published_version_id'),
    /** Whether the live document has moved on since `published_version_id` was written. */
    hasUnpublishedChanges: boolean('has_unpublished_changes').notNull().default(false),
    /** Flattened prose, kept for search; the collab service publishes it as the document changes. */
    text: text('text').notNull().default(''),
    /**
     * Set when this page is a row of a database. A row *is* a page — that is what makes it
     * openable, commentable, versioned and searchable without any of it being built twice.
     */
    databaseId: uuid('database_id'),
    /**
     * The row's cells, keyed by property *key* rather than id, so renaming a column keeps its data.
     * JSONB with a GIN index rather than a row per value: an entity-attribute-value table costs a
     * join per column read and stores every number as text.
     */
    props: jsonObject('props'),
    /** What the server worked out from `props` — formulas and rollups — so a view can sort by one. */
    computed: jsonObject('computed'),
    /**
     * "Never public", travelling with the page rather than with a publication.
     *
     * A `publication_exclusions` join table would be per-publication and more precise, and it fails
     * the wrong way: an exclusion written against one publication does nothing about a publication
     * created later above the same page, so publishing a new root silently re-exposes it. A column
     * holds against publications that do not exist yet, and the public tree walk reads it from the
     * row it already has instead of remembering an anti-join on the one surface where a forgotten
     * join is a leak. The cost is that a page cannot be public in one publication and private in
     * another; a table can be added beside this later, with the column keeping the absolute meaning.
     */
    excludedFromPublic: boolean('excluded_from_public').notNull().default(false),
    createdBy: uuid('created_by'),
    updatedBy: uuid('updated_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    archivedAt: ts('archived_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('pages_ws_space_idx').on(t.workspaceId, t.spaceId, t.position),
    index('pages_ws_parent_idx').on(t.workspaceId, t.parentId, t.position),
    index('pages_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('pages_ws_database_idx').on(t.workspaceId, t.databaseId, t.id),
    index('pages_props_idx').using('gin', t.props),
  ],
)

/**
 * What a page looked like at a moment, and the bytes to put it back.
 *
 * This is the backbone of both halves of the draft model rather than a feature bolted beside it:
 * a `page` serves `pages.published_version_id` to a reader, and a `live` doc serves the Y.Doc — one
 * mechanism, two behaviours. Restoring, diffing and publishing all read from here.
 */
export const pageVersions = schema.table(
  'page_versions',
  {
    id: id(),
    workspaceId: ws(),
    pageId: uuid('page_id').notNull(),
    /**
     * `auto` — taken on a quiet interval while somebody was writing.
     * `publish` — what a reader is being served.
     * `restore` — the result of putting an older version back; a restore is itself a version, so
     *   the act of restoring is never the thing that loses work.
     * `import` — the state a page arrived with.
     */
    kind: text('kind').notNull().default('auto'),
    /** what somebody called it, when they named it on purpose */
    label: text('label'),
    /** `Y.encodeStateAsUpdate` — everything needed to reconstruct the document */
    state: bytea('state').notNull(),
    /** `Y.encodeSnapshot` — enough to render the difference against another version */
    snapshot: bytea('snapshot'),
    /** flattened prose, so a version list can show a line of it without decoding the CRDT */
    text: text('text').notNull().default(''),
    /**
     * The version rendered to HTML once, at publish time, so a public read is a row read.
     *
     * `versions.html` renders the Y.Doc through the Tiptap schema on every call — right for a
     * signed-in reader paging through history, wrong for an endpoint an anonymous crawler hits,
     * because a version is immutable and the work is identical every time. This is what makes a
     * published page a single indexed read and what lets the response be cached by version id.
     *
     * Null, not `''`, for every version written before this column existed: an empty string would
     * claim the version renders to nothing. A publication whose pinned version has no HTML is not
     * servable, which is the same rule as a page with no published version not being public.
     */
    html: text('html'),
    size: integer('size').notNull().default(0),
    authorId: uuid('author_id'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('page_versions_ws_page_idx').on(t.workspaceId, t.pageId, t.createdAt),
    index('page_versions_ws_created_idx').on(t.workspaceId, t.createdAt),
  ],
)

/**
 * A remark on a page, and the piece of text it is about.
 *
 * The anchor is a **Yjs relative position**, not a character offset. An offset names a place in a
 * document that only exists while nobody else is typing: two words inserted above and the comment
 * is attached to something it was never about. A relative position survives concurrent edits
 * because it points at the same piece of content rather than the same index.
 *
 * `quotedText` is what the anchor pointed at when the comment was written. It is not a fallback for
 * a lost anchor — it is what lets the interface say "this was about …" when the text it referred to
 * has since been deleted, instead of showing a thread attached to nothing.
 */
export const comments = schema.table(
  'comments',
  {
    id: id(),
    workspaceId: ws(),
    pageId: uuid('page_id').notNull(),
    /** null for a top-level comment; otherwise the comment this one replies to */
    parentId: uuid('parent_id'),
    /**
     * The comment that starts the thread — itself for a root. Denormalised so a page's threads can
     * be read in one query rather than one per level.
     */
    threadId: uuid('thread_id').notNull(),
    authorId: uuid('author_id'),
    body: jsonObject('body'),
    bodyText: text('body_text').notNull().default(''),
    mentionIds: uuidArray('mention_ids'),
    /** `{ from, to }` as encoded Yjs relative positions; null for a comment on the page as a whole */
    anchor: jsonb('anchor'),
    quotedText: text('quoted_text').notNull().default(''),
    resolvedAt: ts('resolved_at'),
    resolvedBy: uuid('resolved_by'),
    editedAt: ts('edited_at'),
    deletedAt: ts('deleted_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('comments_ws_page_idx').on(t.workspaceId, t.pageId, t.createdAt),
    index('comments_ws_thread_idx').on(t.workspaceId, t.threadId, t.createdAt),
  ],
)

/**
 * A table of pages with typed columns.
 *
 * A database is not a second kind of object beside a page: it *is* a page whose body renders a view
 * instead of prose, and each of its rows is a page too. That is what makes a row openable,
 * commentable, versioned and searchable for free, rather than needing all of it again.
 */
export const databases = schema.table(
  'databases',
  {
    id: id(),
    workspaceId: ws(),
    spaceId: uuid('space_id').notNull(),
    /** the page whose body this database is */
    pageId: uuid('page_id').notNull(),
    name: text('name').notNull().default(''),
    description: text('description').notNull().default(''),
    /** an inline database lives inside another page's prose rather than owning a page */
    inline: boolean('inline').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('databases_ws_page_idx').on(t.workspaceId, t.pageId)],
)

/**
 * A column.
 *
 * `config` carries whatever the type needs — the options of a select, the target of a relation, the
 * expression of a formula — because a column of `jsonb` is the difference between adding a property
 * type and adding a migration.
 */
export const properties = schema.table(
  'properties',
  {
    id: id(),
    workspaceId: ws(),
    databaseId: uuid('database_id').notNull(),
    /** stable across renames; this is what a row's `props` is keyed by */
    key: text('key').notNull(),
    name: text('name').notNull(),
    type: text('type').notNull(),
    config: jsonObject('config'),
    position: text('position').notNull(),
    hidden: boolean('hidden').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('properties_db_key_uq').on(t.workspaceId, t.databaseId, t.key),
    index('properties_ws_db_idx').on(t.workspaceId, t.databaseId, t.position),
  ],
)

/** A saved way of looking at a database: which rows, in what order, drawn how. */
export const views = schema.table(
  'views',
  {
    id: id(),
    workspaceId: ws(),
    databaseId: uuid('database_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull().default('table'),
    /** filters, sorts, grouping, visible properties, column widths, the date property for a calendar */
    config: jsonObject('config'),
    position: text('position').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('views_ws_db_idx').on(t.workspaceId, t.databaseId, t.position)],
)

/**
 * One end of a relation between two rows.
 *
 * A join table rather than an array in `props`, because a relation is symmetric: setting it from
 * one side has to be visible from the other, and a rollup reads it from whichever side asked.
 */
export const relations = schema.table(
  'relations',
  {
    id: id(),
    workspaceId: ws(),
    propertyId: uuid('property_id').notNull(),
    fromPageId: uuid('from_page_id').notNull(),
    toPageId: uuid('to_page_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('relations_uq').on(t.workspaceId, t.propertyId, t.fromPageId, t.toPageId),
    index('relations_ws_from_idx').on(t.workspaceId, t.fromPageId),
    index('relations_ws_to_idx').on(t.workspaceId, t.toPageId),
  ],
)

/**
 * A word a space puts on pages, so they can be gathered by something other than where they sit.
 *
 * Scoped to a space rather than to the workspace: two teams both wanting "Draft" should not have to
 * agree on what it means, and a label list that spans every space is a list nobody can read.
 *
 * The unique index is on `lower(name)`, not on `name`. Case is not a distinction anybody means here
 * — "Draft" and "draft" next to each other in a picker read as a mistake in the data, and whichever
 * one a person clicks is a coin toss. Lowercasing in the constraint rather than in the column keeps
 * the capitalisation somebody chose while refusing the near-duplicate.
 */
export const labels = schema.table(
  'labels',
  {
    id: id(),
    workspaceId: ws(),
    spaceId: uuid('space_id').notNull(),
    name: text('name').notNull(),
    /**
     * One of the closed set in `LabelColour`, stored as text. The contract is what closes it: the
     * palette in `client/database/colours.ts` is the only place a name is turned into a colour pair
     * that has been measured for contrast, and an unknown name falls back to grey rather than
     * rendering a chip with no background.
     */
    colour: text('colour').notNull().default('grey'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('labels_ws_space_name_uq').on(t.workspaceId, t.spaceId, sql`lower(${t.name})`),
    index('labels_ws_space_idx').on(t.workspaceId, t.spaceId, t.name),
  ],
)

/**
 * A label on a page.
 *
 * The primary key is composite and declared in the table's second argument. Two column-level
 * `.primaryKey()` calls are not a composite key — drizzle emits `PRIMARY KEY` on both columns and
 * Postgres refuses the table with "multiple primary keys for table are not allowed". Because the
 * kernel runs a module's migrations at boot, that is not a broken table but a host service that
 * never binds its port, taking every other module in the process down with it.
 *
 * `(page_id, label_id)` leads with the page because reading a page's labels is what happens on every
 * page load; the second index leads with the label, which is what a "everything tagged X" list asks.
 */
export const pageLabels = schema.table(
  'page_labels',
  {
    pageId: uuid('page_id').notNull(),
    labelId: uuid('label_id').notNull(),
    workspaceId: ws(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.labelId] }),
    index('page_labels_ws_label_idx').on(t.workspaceId, t.labelId, t.pageId),
  ],
)

/**
 * A page one person put in their sidebar, and where they put it.
 *
 * Per user, not per workspace: a favourite is somebody's own shortcut, so the key is the person and
 * the page rather than anything shared. `workspace_id` is carried anyway — it is what the row-level
 * policy reads, and without it a favourite would be the one row in this module not fenced by tenant.
 *
 * **`position` is `COLLATE "C"` in the migration and has to stay that way.** It is a fractional
 * index over a base-62 alphabet ordered by code point, so `ORDER BY position` is only the order the
 * algorithm intended under byte comparison; this database is `en_US.UTF-8`, where `'U' < 'c'` is
 * false and a list comes back shuffled. drizzle-kit does not carry collation in its snapshot, so if
 * this migration is ever regenerated, put it back — that is exactly how `properties.position` and
 * `views.position` lost theirs.
 */
export const favorites = schema.table(
  'favorites',
  {
    workspaceId: ws(),
    userId: uuid('user_id').notNull(),
    pageId: uuid('page_id').notNull(),
    position: text('position').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.pageId] }),
    index('favorites_ws_user_idx').on(t.workspaceId, t.userId, t.position),
  ],
)

/**
 * The last time one person opened one page.
 *
 * One row per person per page, updated in place, rather than one row per visit: a log would grow
 * without bound to answer a question that only ever wants the most recent handful, and it would need
 * pruning nobody would remember to run. The write is an upsert on the key that bumps `viewed_at`, so
 * re-opening a page moves it up the list instead of adding to it.
 */
export const recentViews = schema.table(
  'recent_views',
  {
    workspaceId: ws(),
    userId: uuid('user_id').notNull(),
    pageId: uuid('page_id').notNull(),
    viewedAt: ts('viewed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.pageId] }),
    index('recent_views_ws_user_idx').on(t.workspaceId, t.userId, t.viewedAt.desc()),
  ],
)

/**
 * Somebody who asked to hear about a page.
 *
 * Separate from `favorites` because they are different questions: a favourite is "I want this to
 * hand", a watch is "tell me when this changes". Collapsing them means either a sidebar full of
 * pages somebody only wanted notifications about, or a notification for every shortcut they made.
 *
 * The index leads with the page rather than the user, because the read that matters happens on
 * every edit — who has to be told about this — while a person's own list of watches is opened rarely.
 */
export const watchers = schema.table(
  'watchers',
  {
    workspaceId: ws(),
    userId: uuid('user_id').notNull(),
    pageId: uuid('page_id').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.pageId] }),
    index('watchers_ws_page_idx').on(t.workspaceId, t.pageId, t.userId),
  ],
)

/**
 * A page, and everything under it, at a URL a signed-out stranger can open.
 *
 * The row *is* the grant: no publication, no public page, and deleting the row takes the site down.
 * What it points at is a root page and the pinned published version of each page beneath it —
 * `pages.published_version_id` and the HTML on that version, never the Y.Doc and never the draft.
 *
 * **How an anonymous request reaches this table at all** is the question the table exists to answer,
 * and `migrations/0008_publications.sql` answers it at length. In short: *anonymous* means no
 * principal, not no tenant. The public URL is workspace-qualified, the handler resolves the
 * workspace before it touches `mod_quire`, and the policy below is the plain workspace policy every
 * other table has. Nothing about the public path is special at the RLS layer — which is the point,
 * because a surface with no principal is the last place to invent a second isolation mechanism. If
 * the workspace is ever missed, `withWorkspace(null, …)` sets the setting to `''`, no `workspace_id`
 * is ever `''`, and the query returns nothing rather than everything.
 *
 * Two rules the type system cannot hold: the public path runs in a `READ ONLY` transaction (once the
 * workspace is set, RLS is no longer a fence around an anonymous request), and every query on it
 * carries the publication in its own `WHERE` — root page, descendants, `excludedFromPublic` false,
 * a published version present. Workspace scope is not publication scope.
 */
export const publications = schema.table(
  'publications',
  {
    id: id(),
    workspaceId: ws(),
    /** the page the site is rooted at; its own published version is the front page */
    rootPageId: uuid('root_page_id').notNull(),
    /** false publishes exactly one page, which is what a single shared document wants */
    includeDescendants: boolean('include_descendants').notNull().default(true),
    /**
     * The URL segment. Unique per workspace and not beyond it — the workspace is in the public URL,
     * so two customers both wanting `handbook` is not a collision, and an instance-wide namespace
     * would let whoever published first take the word from everyone else.
     */
    slug: text('slug').notNull(),
    /**
     * A PHC string (`$argon2id$…`), or null for a site anybody may read.
     *
     * RLS is row-level, so this column sits inside every row the workspace can read — including on
     * the public path, once the handler has set the workspace. Select it into the verification step
     * and nowhere else: never into a response body, an event payload or a log line.
     */
    passwordHash: text('password_hash'),
    /** null never expires; past means the URL is gone, checked on the request, not by a sweep */
    expiresAt: ts('expires_at'),
    /** what a search result and a link preview say; empty falls back to the root page's own title */
    seoTitle: text('seo_title').notNull().default(''),
    seoDescription: text('seo_description').notNull().default(''),
    ogImageUrl: text('og_image_url'),
    /** false sends `noindex`. Public and findable are different requests, and people mean both. */
    indexable: boolean('indexable').notNull().default(true),
    /** `auto` follows the reader's own setting; `light` and `dark` pin it */
    theme: text('theme').notNull().default('auto'),
    createdBy: uuid('created_by'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('publications_ws_slug_uq').on(t.workspaceId, t.slug),
    index('publications_ws_root_idx').on(t.workspaceId, t.rootPageId),
    index('publications_ws_created_idx').on(t.workspaceId, t.createdAt),
  ],
)

/**
 * A request to take a page, a page and everything under it, or a whole space out of Quire as a file.
 *
 * A row rather than a request that streams its answer, because the work is unbounded: a space is a
 * tree of arbitrary size, and PDF means a round trip to Gotenberg per page. A job that outlives its
 * HTTP request can report progress, can fail with a reason somebody reads afterwards, and can be
 * retried without the browser having stayed open. `counts` and `error` are what make that true — see
 * both below.
 *
 * What the artefact is rendered from is decided elsewhere and is worth stating here anyway, because
 * this table is where somebody looks when the output is wrong: HTML and PDF come from
 * `renderPageDoc`, the same static renderer the public site uses. Never the Y.Doc, never the draft.
 */
export const exportJobs = schema.table(
  'export_jobs',
  {
    id: id(),
    workspaceId: ws(),
    /**
     * **Not null, deliberately, where every other `created_by` in this schema is nullable.**
     *
     * The artefact is the hazard. A subtree export flattens pages with different readerships into one
     * file, so whoever may fetch it may read every page that went into it — handing it to the
     * workspace at large launders the permission check that produced it. Fencing the download to the
     * person who asked needs a person to fence it to, and a row whose requester has gone null cannot
     * be fenced. So the column refuses to be empty and the artefact outlives nobody.
     */
    requestedBy: uuid('requested_by').notNull(),
    /** `page` — one page. `subtree` — a page and its descendants. `space` — every page in a space. */
    scope: text('scope').notNull(),
    /** the page for `page` and `subtree`, the space for `space` — which one is decided by `scope` */
    targetId: uuid('target_id').notNull(),
    /** `markdown` | `html` | `docx` | `pdf` */
    format: text('format').notNull(),
    /** `queued` | `running` | `done` | `failed` */
    state: text('state').notNull().default('queued'),
    /**
     * The artefact in storage, written when the job finishes and null until then.
     *
     * Null while running is the honest state and the one that keeps a half file from being offered:
     * the uploader writes the file, then the job records the id, so there is no window in which this
     * points at bytes that are still arriving. An id is not a URL — the download is a signed URL a
     * procedure mints, never a storage key a client assembles. `migrations/0009` is what that rule
     * cost the last time it was broken.
     */
    fileId: uuid('file_id'),
    /**
     * Why it failed, in the language of the thing that failed — "gotenberg unreachable", a Postgres
     * SQLSTATE, the name of a page that could not be rendered.
     *
     * Diagnostic text, not a user-facing string: whatever a screen shows a person comes from a
     * message key chosen from `state` and the machine-readable part of this. Storing the raw reason
     * is what makes a support question answerable a week later.
     */
    error: text('error'),
    /**
     * The job's own progress, as `{ total, done, skipped, failed }`.
     *
     * `skipped` is not padding: a subtree export by somebody who may not read one of its children
     * leaves that child out, and a count of what was left out is the difference between an export
     * that is missing pages and an export that says so.
     *
     * JSONB rather than four integer columns because the set differs by format and will grow — a PDF
     * export wants `bytes`, a Markdown one does not — and adding a counter should not be a migration
     * against a table whose rows are all transient anyway.
     */
    counts: jsonObject('counts'),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** null while `queued` or `running`; set once, on the transition to `done` or `failed` */
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('export_jobs_ws_created_idx').on(t.workspaceId, t.createdAt.desc()),
    index('export_jobs_ws_state_idx').on(t.workspaceId, t.state, t.createdAt),
  ],
)

/**
 * A Notion export zip, a Confluence export or a folder of Markdown, on its way into a space.
 *
 * The same shape as `export_jobs` pointed the other way, with one addition that carries the weight of
 * the feature: `report`. A real Notion export contains files that will not map — a `.csv` whose
 * database has no columns Quire can type, an asset with no page referring to it, a `.md` whose page
 * id appears twice. An import that silently drops forty pages is worse than one that refuses, so
 * every file gets an entry saying which of the three things happened to it.
 */
export const importJobs = schema.table(
  'import_jobs',
  {
    id: id(),
    workspaceId: ws(),
    /** not null for the same reason as `export_jobs.requested_by` — see the comment there */
    requestedBy: uuid('requested_by').notNull(),
    /** `notion` | `confluence` | `markdown` */
    source: text('source').notNull(),
    /** the space being written into. An import always targets one space; there is no `scope` here. */
    targetId: uuid('target_id').notNull(),
    /**
     * The uploaded archive.
     *
     * **Called `source_file_id` and not `file_id`, on purpose.** `export_jobs.file_id` is the file the
     * job *produces* and is null until it succeeds; this is the file the job *consumes* and exists
     * before the job does. One name pointing in two directions across two tables read by one screen
     * is how a worker ends up writing its output id over the pointer to its input — which loses the
     * archive, so the job cannot be retried and nothing reports that anything went missing. Two names
     * make that mistake a compile error instead.
     */
    sourceFileId: uuid('source_file_id').notNull(),
    /** `queued` | `running` | `done` | `failed` */
    state: text('state').notNull().default('queued'),
    /** why the *job* failed; why one *file* failed is that file's entry in `report` */
    error: text('error'),
    /** `{ total, done, skipped, failed }` — the same counters as an export, over files rather than pages */
    counts: jsonObject('counts'),
    /**
     * One entry per file in the upload: `{ path, outcome, pageId, reason }`.
     *
     * **Why this is a column and not a table.** The report is written by one job and read whole, as
     * one document, by one screen — the person who ran the import, looking at what happened to their
     * import. Nothing joins to an entry, nothing updates an entry after the fact, nothing holds a
     * foreign key into one, and no entry outlives its job. A row-per-file table would mean four
     * thousand inserts to render a list that is only ever fetched by `where job_id = $1`, plus a
     * second tenant table with its own `workspace_id`, its own policy, its own `TENANT_TABLES` entry
     * and its own retention rule — all to store a document. Dropping the job drops its report here;
     * there is nothing to sweep.
     *
     * The size is the part worth checking rather than assuming: an entry is a path, one of three
     * words, and either a uuid or a sentence, so a five-thousand-file import is a few hundred
     * kilobytes — one TOASTed value read once. That holds for the exports people actually have.
     *
     * **What would change if somebody wanted to query across imports** — "every file that failed for
     * this reason, across every import this month" — is that this stops being the right shape, and
     * not by a little. `jsonb_array_elements` over the whole table can answer it, but no index helps:
     * a GIN index on this column serves containment (`@>`), not a predicate and an ordering inside
     * the array. The change is a `mod_quire.import_entries` table — `job_id`, `workspace_id`, `path`,
     * `outcome`, `page_id`, `reason` — indexed on `(workspace_id, outcome, created_at)`, written by
     * the same worker, with the existing rows backfilled by expanding this column through
     * `jsonb_to_recordset`. It is a tenant table, so it arrives with the full triple (workspace_id,
     * FORCE RLS, one policy) and an entry in `TENANT_TABLES`, and it needs the retention rule this
     * column gets for free. The threshold is exactly that question: while every read names one job,
     * the column is right.
     */
    report: jsonArray('report'),
    createdAt: ts('created_at').notNull().defaultNow(),
    /** null while `queued` or `running`; set once, on the transition to `done` or `failed` */
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('import_jobs_ws_created_idx').on(t.workspaceId, t.createdAt.desc()),
    index('import_jobs_ws_state_idx').on(t.workspaceId, t.state, t.createdAt),
  ],
)

/** Every tenant table, so the RLS migration can be checked against one list rather than memory. */
export const TENANT_TABLES = [
  'spaces',
  'pages',
  'page_versions',
  'comments',
  'databases',
  'properties',
  'views',
  'relations',
  'labels',
  'page_labels',
  'favorites',
  'recent_views',
  'watchers',
  'publications',
  'export_jobs',
  'import_jobs',
] as const
