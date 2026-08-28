/**
 * A zip container, read by hand — the mirror of `../export/zip.ts`.
 *
 * The same trade, for the same reason: a Notion export, a Confluence export and a folder of Markdown
 * are all the 1989 format — store or deflate, no encryption, sizes in the header — and that is about
 * a hundred lines of well-specified reading. Every module repository commits its own lockfile, so a
 * dependency here is a lockfile refresh outside the workspace before it is a line of code.
 *
 * **Reading is the dangerous direction, and the danger is not the format.** An archive somebody
 * uploads is hostile input, so three things are refused rather than trusted:
 *
 *   1. **Sizes are what the header claims until the bytes prove otherwise.** A 40 KB entry that
 *      declares 4 GB uncompressed is the classic zip bomb; `inflateRawSync` is therefore given a hard
 *      `maxOutputLength` and the result is checked against the declared length *and* the CRC. A
 *      mismatch is that entry's failure, not the archive's.
 *   2. **The whole archive is bounded before any of it is decompressed**, by entry count and by the
 *      sum of the declared uncompressed sizes. A thousand entries each declaring 500 MB is refused
 *      without inflating one of them.
 *   3. **A path is never a place on disk.** Nothing here writes a file, which removes the classic
 *      traversal — but a path is still used as a key, a parent and a title, so `..`, an absolute
 *      path and a backslash separator are normalised or refused here rather than in four readers.
 *
 * A malformed *entry* is reported and skipped; a malformed *archive* throws, because there is nothing
 * to report against. That split is the whole shape of this file's error handling and it matches what
 * the import promises: a file that cannot be read gets a row saying so, and an upload that is not a
 * zip is a job that fails before anything is written.
 */
import { inflateRawSync } from 'node:zlib'
import { KernError } from '@kernhq/kernel'

/** Signatures, spelled out so a misread offset fails loudly instead of producing plausible bytes. */
const SIG_EOCD = 0x0605_4b50
const SIG_EOCD64_LOCATOR = 0x0706_4b50
const SIG_CENTRAL = 0x0201_4b50
const SIG_LOCAL = 0x0403_4b50

/** The end-of-central-directory record is 22 bytes plus a comment of up to 64 KB. */
const EOCD_MIN = 22
const MAX_COMMENT = 0xffff

export interface ArchiveLimits {
  /** how many entries may be listed at all */
  maxEntries: number
  /** the sum of every entry's declared uncompressed size */
  maxTotalBytes: number
  /** the largest single file that will be inflated */
  maxEntryBytes: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 5_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxEntryBytes: 64 * 1024 * 1024,
}

/**
 * One file out of the archive.
 *
 * `data` and `error` are exclusive: an entry either came out or says why it did not. The error is
 * carried rather than thrown so that one corrupt picture in a five-thousand-file Notion export is a
 * line in the report instead of an import nobody can run.
 */
export interface ArchiveEntry {
  /** the path exactly as the archive spelled it, which is what a report has to name */
  path: string
  /** the same path normalised: `/`-separated, no `.`, no `..`, no leading slash, never empty */
  key: string
  data: Buffer | null
  error: string | null
}

/**
 * A path that names a place *inside* the archive and nowhere else.
 *
 * Returns null for anything that would climb out of it. Nothing here writes to disk, so this is not
 * the last line of defence it would be in an unzipper — but the path becomes a lookup key, a parent
 * and sometimes a page title, and `../../secrets/keys.md` resolving to the same key as a real file is
 * how two files silently become one.
 */
export function normaliseArchivePath(raw: string): string | null {
  const out: string[] = []
  for (const segment of raw.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      /*
       * A `..` that stays inside the archive is resolved, not refused. Refusing every one of them
       * looks like the safe reading and is the wrong one: `../` is how a *correct* relative link
       * between two folders is spelled, and it is what this module's own exporter writes for every
       * link that is not strictly downward — a child to its parent, a page to its sibling. Refusing
       * them turned those links into plain text on re-import and reported the target as absent when
       * it was sitting in the archive.
       *
       * The property the refusal was there for is kept exactly: a `..` with nothing left to pop
       * would name something above the archive root, so it still returns null. `../secrets/keys.md`
       * and `a/../../secrets/keys.md` are both refused; `a/../b.md` is `b.md`, which is what every
       * reader of the format resolves it to. Two entries that normalise to one key are caught by
       * `readZip`'s duplicate check rather than silently becoming one file.
       */
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length > 0 ? out.join('/') : null
}

/** `a/b/c.md` → `a/b`; a file at the top is `''`. */
export const dirnameOf = (key: string): string => {
  const at = key.lastIndexOf('/')
  return at < 0 ? '' : key.slice(0, at)
}

/** `a/b/c.md` → `c.md`. */
export const basenameOf = (key: string): string => key.slice(key.lastIndexOf('/') + 1)

/** `c.md` → `.md`, lower-cased; a name with no dot has no extension. */
export function extensionOf(key: string): string {
  const name = basenameOf(key)
  const at = name.lastIndexOf('.')
  return at > 0 ? name.slice(at).toLowerCase() : ''
}

/**
 * Resolve one archive path against another, the way a browser resolves a relative href.
 *
 * `from` is the *file* the link is written in, not its folder — passing the file is what makes the
 * call sites read correctly, and forgetting to take the dirname is the bug this signature removes.
 */
export function resolveArchivePath(fromFile: string, href: string): string | null {
  if (href.startsWith('/')) return normaliseArchivePath(href)
  const base = dirnameOf(fromFile)
  return normaliseArchivePath(base ? `${base}/${href}` : href)
}

/** Find the end-of-central-directory record, scanning back over a comment of any legal length. */
function findEocd(buffer: Buffer): number {
  const earliest = Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT)
  for (let at = buffer.length - EOCD_MIN; at >= earliest; at--)
    if (buffer.readUInt32LE(at) === SIG_EOCD) return at
  return -1
}

/**
 * Every file in the archive, in central-directory order.
 *
 * Order matters more than it looks: it is the order the report is written in, and a report whose rows
 * are in a different order every time is one nobody can compare against the last run.
 */
export function readZip(buffer: Buffer, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): ArchiveEntry[] {
  if (buffer.length < EOCD_MIN) throw KernError.badRequest('That upload is too small to be a zip archive')

  const eocd = findEocd(buffer)
  if (eocd < 0)
    throw KernError.badRequest(
      'That upload is not a zip archive: it has no end-of-central-directory record. ' +
        'Export again and upload the .zip file itself rather than a folder or a single document.',
    )

  const declaredCount = buffer.readUInt16LE(eocd + 10)
  const directoryAt = buffer.readUInt32LE(eocd + 16)

  /*
   * ZIP64 is refused rather than half-read. Both markers mean the real numbers live in a record this
   * reader does not parse, so carrying on would silently read the *wrong* offsets — an archive that
   * appears to hold 65,535 files. An archive that large is beyond the import's own limits anyway, so
   * the refusal costs nothing and the alternative is a wrong answer.
   */
  const hasZip64Locator = eocd >= 20 && buffer.readUInt32LE(eocd - 20) === SIG_EOCD64_LOCATOR
  if (declaredCount === 0xffff || directoryAt === 0xffff_ffff || hasZip64Locator)
    throw KernError.badRequest(
      'That archive is in ZIP64 format, which is more than one import can carry. Export it in ' +
        'smaller pieces — one space, or one section at a time.',
    )

  if (declaredCount > limits.maxEntries)
    throw KernError.badRequest(
      `That archive holds ${declaredCount} files, and one import may carry ${limits.maxEntries}. ` +
        'Export it in smaller pieces — one space, or one section at a time.',
    )

  const entries: ArchiveEntry[] = []
  const seen = new Set<string>()
  let declaredTotal = 0
  let at = directoryAt

  for (let n = 0; n < declaredCount; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== SIG_CENTRAL)
      throw KernError.badRequest(
        `That archive is damaged: its file list stops after ${n} of ${declaredCount} entries.`,
      )

    const flags = buffer.readUInt16LE(at + 8)
    const method = buffer.readUInt16LE(at + 10)
    const crc = buffer.readUInt32LE(at + 16)
    const compressedSize = buffer.readUInt32LE(at + 20)
    const uncompressedSize = buffer.readUInt32LE(at + 24)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localAt = buffer.readUInt32LE(at + 42)
    /*
     * The name is decoded as UTF-8 whatever bit 11 says.
     *
     * That bit means "this name is UTF-8", and without it the name is nominally CP437 — but every
     * archiver that matters has written UTF-8 for a decade, Notion, Confluence and macOS included,
     * and plenty of them omit the flag anyway. Honouring the flag would turn a correct Persian page
     * title into mojibake on the archives that forget it, and CP437 and UTF-8 agree on ASCII, so
     * decoding as UTF-8 is right for every archive either of them produces.
     */
    const rawName = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    at += 46 + nameLength + extraLength + commentLength

    // A directory entry carries no bytes and is not a file anybody can report on.
    if (rawName.endsWith('/') || rawName.endsWith('\\')) continue

    const key = normaliseArchivePath(rawName)
    if (key === null) {
      entries.push({
        path: rawName,
        key: rawName,
        data: null,
        error: 'the archive gives this file a path that points outside the archive',
      })
      continue
    }
    if (seen.has(key)) {
      entries.push({
        path: rawName,
        key,
        data: null,
        error: 'the archive holds two files at this path, and only the first was read',
      })
      continue
    }
    seen.add(key)

    declaredTotal += uncompressedSize
    if (declaredTotal > limits.maxTotalBytes)
      throw KernError.badRequest(
        `That archive unpacks to more than ${Math.round(limits.maxTotalBytes / 1_048_576)} MB, ` +
          'which is more than one import may carry. Export it in smaller pieces.',
      )

    if (uncompressedSize > limits.maxEntryBytes) {
      entries.push({
        path: rawName,
        key,
        data: null,
        error: `it is ${Math.round(uncompressedSize / 1_048_576)} MB, and one file may be ${Math.round(
          limits.maxEntryBytes / 1_048_576,
        )} MB`,
      })
      continue
    }
    // Bit 0 is "encrypted". The bytes are unreadable without a password nobody has given us.
    if ((flags & 0x0001) !== 0) {
      entries.push({
        path: rawName,
        key,
        data: null,
        error: 'it is encrypted, and an import has no password',
      })
      continue
    }
    if (method !== 0 && method !== 8) {
      entries.push({
        path: rawName,
        key,
        data: null,
        error: `it uses compression method ${method}, and an import reads only stored and deflated files`,
      })
      continue
    }

    entries.push(readEntry(buffer, { rawName, key, localAt, method, crc, compressedSize, uncompressedSize }))
  }

  /*
   * The count in the end record has to agree with the directory it counts.
   *
   * The loop above reads exactly `declaredCount` headers, so an archive that lists twelve files and
   * says ten hands back ten — and the two it did not read appear in no report row, which is the one
   * silent drop this reader could still produce. Everything else that goes wrong with a file becomes
   * a row; a file nobody read cannot. The directory continuing past the count is the whole test, and
   * it fires on nothing else: a well-formed archive has the end record (or a ZIP64 one, already
   * refused above) at exactly this offset.
   */
  if (at + 4 <= buffer.length && buffer.readUInt32LE(at) === SIG_CENTRAL)
    throw KernError.badRequest(
      `That archive is damaged: it says it holds ${declaredCount} files and its file list holds more, ` +
        'so some of them would be imported without being read. Export it again.',
    )

  return entries
}

interface EntryHeader {
  rawName: string
  key: string
  localAt: number
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
}

/**
 * One entry's bytes, checked against everything the archive claimed about them.
 *
 * The local header is re-read rather than trusted from the central directory, which is what a real
 * unzipper does: the two disagree in archives written by tools that patch one and not the other, and
 * the local header is the one the data actually follows.
 */
function readEntry(buffer: Buffer, header: EntryHeader): ArchiveEntry {
  const { rawName, key } = header
  const fail = (error: string): ArchiveEntry => ({ path: rawName, key, data: null, error })

  if (header.localAt + 30 > buffer.length || buffer.readUInt32LE(header.localAt) !== SIG_LOCAL)
    return fail('the archive has no record of where this file starts')

  const nameLength = buffer.readUInt16LE(header.localAt + 26)
  const extraLength = buffer.readUInt16LE(header.localAt + 28)
  const start = header.localAt + 30 + nameLength + extraLength
  const end = start + header.compressedSize
  if (end > buffer.length) return fail('the archive ends before this file does')

  const raw = buffer.subarray(start, end)
  let data: Buffer
  try {
    data =
      header.method === 8
        ? // The cap is what turns a zip bomb into one refused entry rather than the process's memory.
          Buffer.from(inflateRawSync(raw, { maxOutputLength: header.uncompressedSize + 1 }))
        : Buffer.from(raw)
  } catch (err) {
    return fail(`it could not be decompressed (${err instanceof Error ? err.message : String(err)})`)
  }

  if (data.length !== header.uncompressedSize)
    return fail(`it unpacked to ${data.length} bytes where the archive said ${header.uncompressedSize}`)
  if (crc32(data) !== header.crc) return fail('its checksum does not match, so the file is damaged')

  return { path: rawName, key, data, error: null }
}

/** The same polynomial the writer next door uses; a wrong one reads as "every file is damaged". */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb8_8320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffff_ffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffff_ffff) >>> 0
}

/**
 * The bytes as text, if they are text at all.
 *
 * A UTF-8 BOM is stripped — Confluence's HTML export writes one, and a `# Heading` behind a BOM is a
 * paragraph beginning with an invisible character rather than a heading. A file holding a NUL in its
 * first kilobyte is binary and is refused here, so a JPEG never reaches the Markdown parser.
 */
export function textOf(data: Buffer): string | null {
  const probe = data.subarray(0, 1024)
  for (const byte of probe) if (byte === 0) return null
  const text = data.toString('utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}
