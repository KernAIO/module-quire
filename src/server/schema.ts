import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
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
] as const
