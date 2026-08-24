import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
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
  ],
)

/** Every tenant table, so the RLS migration can be checked against one list rather than memory. */
export const TENANT_TABLES = ['spaces', 'pages'] as const
