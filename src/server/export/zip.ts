/**
 * A zip container, written by hand.
 *
 * An export of a subtree or a space is a folder per page with its pictures beside it, which is a zip
 * and cannot reasonably be anything else. Writing the container here rather than taking a dependency
 * is a deliberate trade and worth stating: the format needed is the 1989 one — deflate or store, no
 * encryption, no ZIP64, sizes known before the entry is written — and that is about a hundred lines
 * of well-specified header. `archiver` and `jszip` are streaming libraries whose job is everything
 * this does not need, and every module repository commits its own lockfile, so a dependency here is
 * a lockfile refresh outside the workspace in six places before it is a line of code.
 *
 * The limits are the honest part of that trade, and they are checked rather than assumed. No ZIP64
 * means an archive is refused above 4 GiB, an entry above 4 GiB, or 65,535 entries — refused with a
 * message, never truncated into a file that unzips to something incomplete. An export that would hit
 * one of those is a job that fails and says so, which is the rule the whole slice is built on.
 *
 * Everything is deflated except what deflate makes bigger, which is most already-compressed pictures.
 * The comparison is done rather than guessed from the extension: a PNG of flat colour still shrinks.
 */
import { deflateRawSync } from 'node:zlib'

/** 0xFFFFFFFF. Above this an offset or a size needs ZIP64, which this writer does not emit. */
const MAX_32 = 0xffff_ffff
/** The count field in the end-of-central-directory record is 16 bits. */
const MAX_ENTRIES = 0xffff

/** `crc32` over the whole entry, which the reader checks — a wrong one is a "corrupt archive". */
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
 * The MS-DOS date and time a zip entry carries, from a real clock.
 *
 * Not a constant: an archive whose every file is stamped 1980 looks broken in a file manager, and
 * some restore tools treat it as such. The resolution is two seconds, which is the format's, and the
 * clock is UTC because the format has no zone and a local one would make the same export produce
 * different bytes on two machines.
 */
function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear())
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  }
}

export interface ZipEntry {
  /** the path inside the archive, `/`-separated and never absolute or `..`-relative */
  path: string
  data: Uint8Array
}

/** What a caller may not exceed, so a refusal can name the number it broke. */
export const ZIP_LIMITS = { maxTotalBytes: MAX_32, maxEntryBytes: MAX_32, maxEntries: MAX_ENTRIES }

/**
 * A path that cannot escape the folder somebody unzips into.
 *
 * A page title becomes a folder name, and a title is user input: `../../etc/whatever` is a real
 * archive somebody can be handed, and a tool that follows it writes outside the extraction
 * directory. Every segment is cleaned rather than rejected, because refusing an export because
 * somebody named a page `C:\` would be absurd — but the cleaning is total, so nothing survives that
 * a reader could resolve upwards.
 */
export function safeZipPath(path: string): string {
  const segments = path
    .split('/')
    .map((segment) =>
      segment
        .normalize('NFC')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are exactly what a filename must not carry
        .replace(/[\u0000-\u001f\u007f\\:*?"<>|]+/g, '-')
        .replace(/^\.+$/, '-')
        .replace(/^\s+|[\s.]+$/g, '')
        .slice(0, 100),
    )
    .filter((segment) => segment.length > 0)
  return segments.join('/')
}

/**
 * Every entry, in one buffer.
 *
 * Sizes are known before anything is written, so no entry carries a data descriptor and no reader
 * has to seek backwards — which is what makes the output openable by the strictest tools as well as
 * by the forgiving ones.
 */
export function writeZip(entries: ZipEntry[], now = new Date()): Buffer {
  if (entries.length > MAX_ENTRIES)
    throw new Error(`This export has ${entries.length} files, and a zip may hold ${MAX_ENTRIES}`)

  const { time, date } = dosStamp(now)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8')
    const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)
    if (raw.length > MAX_32) throw new Error(`${entry.path} is larger than 4 GB, which a zip cannot hold`)
    const deflated = raw.length > 0 ? deflateRawSync(raw, { level: 6 }) : Buffer.alloc(0)
    // Stored rather than deflated when deflate did not help — which is the normal case for a JPEG.
    const compress = deflated.length < raw.length
    const body = compress ? deflated : raw
    const crc = crc32(raw)

    if (offset > MAX_32 - body.length - name.length - 30)
      throw new Error('This export is larger than 4 GB, which is more than a zip can address')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x0403_4b50, 0)
    local.writeUInt16LE(20, 4)
    // 0x0800: the name below is UTF-8. Without it a Persian page title is mojibake on extraction.
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(compress ? 8 : 0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x0201_4b50, 0)
    // Made by a Unix zip (3), spec 2.0 — so the permission bits below are read as Unix ones.
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(compress ? 8 : 0, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    // 0o100644 in the high half: a regular file somebody owns and everyone may read.
    // Multiplied rather than shifted — `<<` is a 32-bit *signed* operator, so `0o100644 << 16` is
    // negative and `writeUInt32LE` throws on it. The whole archive fails to build, at the last entry.
    central.writeUInt32LE(0o100644 * 0x1_0000, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x0605_4b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...locals, directory, end])
}
