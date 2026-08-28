/**
 * The server fetching a URL somebody typed into a page.
 *
 * This is the most dangerous thing in the module, and it is worth saying why before anything else.
 * Core listens on :4000 and Postgres on :5432 **on the same host as this process**, and a cloud
 * instance sits behind a metadata service at 169.254.169.254 that hands out credentials to anyone
 * who asks. A fetcher that will retrieve any address a user supplies is a way to make Kern read all
 * of that on the attacker's behalf and hand back what it found — which is what "unfurl this link"
 * would be, written the obvious way.
 *
 * So the defences come first and the feature second. In order, and every one of them is load-bearing:
 *
 *   1. **Scheme.** `http:` and `https:` only. `file:`, `gopher:` and `data:` are not addresses on
 *      the web, and a redirect to one is a redirect out of this function's assumptions.
 *   2. **No credentials in the URL.** `http://user:pass@host/` sends those to the host, and a URL
 *      with them in is either an accident or a way to reach something that asked for them.
 *   3. **Resolve, then judge.** The hostname is resolved and *every* address it answers with has to
 *      be public. `evil.example` resolving to 127.0.0.1 is the ordinary way past a name-based check,
 *      and a name-based check is the only kind that can run before DNS.
 *   4. **Then the allow-list**, on the hostname, *after* the address check rather than instead of
 *      it. Order matters: an allow-list entry must never be a way *past* the address rule, so a host
 *      an administrator allowed which today resolves into private space is still refused.
 *   5. **The connection is pinned to the addresses that were checked.** The guard is installed as
 *      the socket's own `lookup`, so there is no second resolution between the check and the
 *      connection for a DNS rebind to win — which is why this uses `node:http` rather than `fetch`,
 *      whose dispatcher cannot be given one without pulling undici in.
 *   6. **Every redirect is a new request and gets the whole check again.** The first response is
 *      public and the second one is the loopback interface: that is the entire trick, and it is why
 *      redirects are followed here by hand rather than by the HTTP client.
 *   7. **A ceiling on the body, the time and the number of hops**, because a fetcher with none is a
 *      way to hold a worker open on a socket that trickles bytes for ever.
 *
 * **The allow-list is empty by default, and every unfurl is refused until an operator sets one.**
 * That is deliberate rather than unfinished. Fetching arbitrary addresses on a user's say-so is a
 * capability an instance's operator should have to grant on purpose, and a self-hosted Kern sitting
 * inside somebody's private network is exactly the deployment where granting it by default would be
 * worst. `QUIRE_EMBED_HOSTS` is the switch; the procedure says so when it refuses, so an
 * administrator reads a sentence about a setting rather than "something went wrong".
 *
 * What this file is **not** for: Kern's own objects. A page, an issue or a channel is named by
 * reference and resolved through `objectTypes`/`resolvers` against whoever is reading — see
 * `objects.ts`. Unfurling our own URL would point this fetcher at core, and would freeze a
 * permission question into a stored answer.
 */

import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { KernError, type Kernel } from '@kernhq/kernel'
import {
  PAGE_EMBED_MAX_DESCRIPTION,
  PAGE_EMBED_MAX_SITE,
  PAGE_EMBED_MAX_TITLE,
  PAGE_EMBED_MAX_URL,
} from '@kernhq/ui/editor/page-doc'

/* ---------------------------------------------------------------------------------------------- */
/* Refusals                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Why an address was not fetched.
 *
 * Named rather than free text, because the caller has to be able to tell an operator's problem
 * ("nobody has allowed any host") from a writer's ("that address is not one of them") from the
 * site's ("it never answered"), and because the tests assert on them: a refusal for the wrong
 * reason is a check that happened to catch something the *next* URL will walk past.
 */
export const UNFURL_REFUSALS = [
  'no_allowlist',
  'not_allowed',
  'private_address',
  'unresolvable',
  'bad_url',
  'too_many_redirects',
  'unreachable',
  'not_readable',
] as const
export type UnfurlRefusal = (typeof UNFURL_REFUSALS)[number]

export class UnfurlRefused extends Error {
  constructor(readonly refusal: UnfurlRefusal) {
    super(refusal)
    this.name = 'UnfurlRefused'
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* Address space                                                                                    */
/* ---------------------------------------------------------------------------------------------- */

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    out.push(value)
  }
  return out
}

/**
 * Everything IPv4 reserves, refused.
 *
 * Written out rather than reduced to "not 10/8, 172.16/12, 192.168/16", because the ones people
 * forget are the ones that matter here: `169.254.169.254` is a cloud metadata service, `0.0.0.0` is
 * *this host* on Linux, and `100.64/10` is a carrier's inside. A decimal or hex-encoded address —
 * `http://2130706433/` — never reaches this function looking like one: the WHATWG URL parser
 * normalises a special-scheme host to dotted quad before anything here sees it.
 */
function publicV4(parts: number[]): boolean {
  const [a = 0, b = 0, c = 0] = parts
  if (a === 0) return false // 0.0.0.0/8 — "this network", and 0.0.0.0 is every local interface
  if (a === 10) return false
  if (a === 127) return false // loopback
  if (a === 100 && b >= 64 && b <= 127) return false // 100.64/10, carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local, which is where the metadata service lives
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false // TEST-NET-3
  if (a >= 224) return false // multicast, reserved, and 255.255.255.255
  return true
}

/**
 * The same, for IPv6, and the four traps that make it harder.
 *
 * `::1` is loopback and everybody checks it. What gets missed is that IPv6 has three separate ways
 * to *carry* an IPv4 address — `::ffff:127.0.0.1` (mapped), `64:ff9b::7f00:1` (NAT64) and
 * `2002::/16` (6to4) — and a check that only refuses `fc00::/7` and `fe80::/10` lets every one of
 * them through to the loopback interface. So an embedded address is unwrapped and judged as IPv4.
 */
function publicV6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
  const embedded = (high: number, low: number) => [high >> 8, high & 0xff, low >> 8, low & 0xff]

  // `::`, `::1`, and the deprecated `::a.b.c.d` — the first six groups zero means an embedded v4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff) return publicV4(embedded(g6, g7)) // IPv4-mapped
    if (g5 === 0) {
      if (g6 === 0 && g7 <= 1) return false // :: and ::1
      return publicV4(embedded(g6, g7)) // IPv4-compatible
    }
  }
  if (g0 === 0x0064 && g1 === 0xff9b) return publicV4(embedded(g6, g7)) // NAT64 well-known prefix
  if (g0 === 0x2002) return publicV4(embedded(g1, g2)) // 6to4
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return false // discard-only
  if ((g0 & 0xfe00) === 0xfc00) return false // unique local
  if ((g0 & 0xffc0) === 0xfe80) return false // link-local
  if ((g0 & 0xff00) === 0xff00) return false // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false // documentation
  return true
}

function ipv6Groups(ip: string): number[] | null {
  let text = (ip.split('%')[0] ?? '').toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  if (!text.includes(':')) return null

  // A trailing dotted quad is two groups written the other way round.
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text)
  if (dotted) {
    const quad = ipv4Parts(dotted[1] as string)
    if (!quad) return null
    const high = (((quad[0] as number) << 8) | (quad[1] as number)).toString(16)
    const low = (((quad[2] as number) << 8) | (quad[3] as number)).toString(16)
    text = `${text.slice(0, dotted.index)}${high}:${low}`
  }

  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? (halves[0] as string).split(':') : []
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : []
  let parts: string[]
  if (halves.length === 1) {
    if (head.length !== 8) return null
    parts = head
  } else {
    const missing = 8 - head.length - tail.length
    if (missing < 0) return null
    parts = [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
  }

  const groups: number[] = []
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null
    groups.push(Number.parseInt(part, 16))
  }
  return groups
}

/**
 * Is this address one the public internet can route to?
 *
 * **Anything this function cannot parse is not public.** That is the direction the default has to
 * fall: an address shape nobody here anticipated is exactly the one an attacker went looking for.
 */
export function isPublicAddress(ip: string): boolean {
  const trimmed = ip.trim()
  const v4 = ipv4Parts(trimmed)
  if (v4) return publicV4(v4)
  const v6 = ipv6Groups(trimmed)
  if (v6) return publicV6(v6)
  return false
}

/* ---------------------------------------------------------------------------------------------- */
/* The allow-list                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * `QUIRE_EMBED_HOSTS`, as a list.
 *
 * `example.com` allows exactly that host. `.example.com` allows it and everything under it — spelled
 * with a leading dot rather than inferred, because "allow github.com" and "allow every host anybody
 * can create under github.io" are different decisions and an operator should have to make the second
 * one on purpose.
 */
export function parseHostAllowlist(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, ''))
    .filter((entry) => entry.length > 0 && /^\.?[a-z0-9.-]+$/.test(entry))
}

export function hostAllowed(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!host) return false
  for (const entry of allowlist) {
    if (entry.startsWith('.')) {
      if (host === entry.slice(1) || host.endsWith(entry)) return true
    } else if (host === entry) return true
  }
  return false
}

/* ---------------------------------------------------------------------------------------------- */
/* Checking one hop                                                                                 */
/* ---------------------------------------------------------------------------------------------- */

export interface UnfurlPolicy {
  /** Hosts an operator has allowed. Empty means every unfurl is refused. */
  allowHosts: readonly string[]
  /** How many redirects to follow. Each one is checked in full before it is requested. */
  maxRedirects?: number
  /** The whole thing, redirects included. */
  timeoutMs?: number
  /** How much of a page is read before the socket is dropped. The metadata is in the first few KB. */
  maxBytes?: number
  /**
   * How a hostname is resolved. Injectable so a test can prove the guard refuses a *name* that
   * answers with 127.0.0.1 — which is the attack, and which cannot be arranged with real DNS.
   */
  resolve?: (hostname: string) => Promise<string[]>
  /** One request, no redirect following. Injectable so the redirect rule can be tested off-network. */
  hop?: (url: URL, addresses: string[], policy: Required<UnfurlPolicy>) => Promise<Hop>
}

export interface Hop {
  status: number
  location: string | null
  contentType: string | null
  body: string
}

const DEFAULT_REDIRECTS = 3
const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_BYTES = 128 * 1024

const resolveWithDns = (hostname: string): Promise<string[]> =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses: LookupAddress[]) => {
      if (err) reject(new UnfurlRefused('unresolvable'))
      else resolve(addresses.map((a) => a.address))
    })
  })

/**
 * Everything that has to be true before a request is made, in the order it has to be true in.
 *
 * Returns the addresses, because the connection is then pinned to exactly these — checking an
 * address and then letting the socket resolve the name again is checking a different address from
 * the one that gets connected to.
 */
export async function checkTarget(url: URL, policy: UnfurlPolicy): Promise<string[]> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnfurlRefused('bad_url')
  if (url.username || url.password) throw new UnfurlRefused('bad_url')
  if (url.href.length > PAGE_EMBED_MAX_URL) throw new UnfurlRefused('bad_url')
  if (policy.allowHosts.length === 0) throw new UnfurlRefused('no_allowlist')

  const hostname = url.hostname.replace(/^\[|\]$/g, '')

  /*
   * A literal address is its own resolution, so there is nothing to look up — and it is checked
   * before the allow-list for the reason given at the top of this file: the allow-list must never
   * be a way past the address rule.
   */
  const addresses = isIP(hostname) ? [hostname] : await (policy.resolve ?? resolveWithDns)(hostname)
  if (addresses.length === 0) throw new UnfurlRefused('unresolvable')
  for (const address of addresses) if (!isPublicAddress(address)) throw new UnfurlRefused('private_address')

  if (!hostAllowed(hostname, policy.allowHosts)) throw new UnfurlRefused('not_allowed')
  return addresses
}

/* ---------------------------------------------------------------------------------------------- */
/* One request                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One HTTP request that does not follow redirects, capped in bytes and in time.
 *
 * `node:http` rather than `fetch`, and the reason is the `lookup` below: it is the only place a
 * resolution can be pinned to addresses that have already been judged, and Node's `fetch` gives no
 * way to install one without adding undici as a dependency. `agent: false` because a pooled socket
 * is keyed on host and port and *not* on the lookup, so pooling would happily hand back a connection
 * that was opened under someone else's guard.
 */
export async function httpHop(url: URL, addresses: string[], policy: Required<UnfurlPolicy>): Promise<Hop> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise<Hop>((resolve, reject) => {
    let settled = false
    const done = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }

    const req = send(
      url,
      {
        method: 'GET',
        agent: false,
        // Pinned. The socket connects to an address this request has already had judged, and there
        // is no second resolution between the check and the connection.
        lookup: (_hostname, options, callback) => {
          const chosen = addresses.map((address) => ({
            address,
            family: isIP(address) === 6 ? 6 : 4,
          }))
          if (typeof options === 'object' && options?.all)
            (callback as unknown as (e: null, a: unknown) => void)(null, chosen)
          else {
            const first = chosen[0] as { address: string; family: number }
            callback(null, first.address, first.family)
          }
        },
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-language': 'en',
          'user-agent': 'Kern (+https://kernaio.com)',
        },
      },
      (res) => {
        const status = res.statusCode ?? 0
        const contentType = (res.headers['content-type'] ?? null) as string | null
        const location = (res.headers.location ?? null) as string | null
        /*
         * A redirect and a non-HTML body are both answered without reading anything: there is no
         * metadata in a 3 GB video, and reading one is how a fetcher becomes a way to make the
         * server download things.
         */
        if (status >= 300 && status < 400) {
          res.destroy()
          return done(() => resolve({ status, location, contentType, body: '' }))
        }
        if (contentType && !/^\s*(text\/html|application\/xhtml\+xml|text\/plain)/i.test(contentType)) {
          res.destroy()
          return done(() => resolve({ status, location: null, contentType, body: '' }))
        }
        let size = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          chunks.push(chunk)
          // Enough to hold a `<head>`; the rest of the page is not metadata and is not read.
          if (size >= policy.maxBytes) res.destroy()
        })
        const finish = () =>
          done(() =>
            resolve({
              status,
              location: null,
              contentType,
              body: Buffer.concat(chunks).subarray(0, policy.maxBytes).toString('utf8'),
            }),
          )
        res.on('end', finish)
        // A destroyed response is the cap doing its job, not a failure: keep what was read.
        res.on('close', finish)
        res.on('error', finish)
      },
    )

    const timer = setTimeout(() => {
      req.destroy()
      done(() => reject(new UnfurlRefused('unreachable')))
    }, policy.timeoutMs)
    timer.unref?.()

    req.on('error', () => done(() => reject(new UnfurlRefused('unreachable'))))
    req.on('close', () => clearTimeout(timer))
    req.end()
  })
}

/* ---------------------------------------------------------------------------------------------- */
/* Reading the metadata                                                                             */
/* ---------------------------------------------------------------------------------------------- */

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
}

/**
 * Enough entity decoding to read a headline, and no more.
 *
 * The result is escaped again by the renderer before it reaches a page, so this is about the words
 * being right rather than about safety — `AT&amp;T` should be stored as `AT&T` and not as five
 * characters of markup somebody has to read past.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const key = name.toLowerCase()
    const known = ENTITIES[key]
    if (known) return known
    if (key.startsWith('#x')) {
      const code = Number.parseInt(key.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(key.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
    }
    return whole
  })
}

const clean = (text: string | null | undefined, max: number): string | null => {
  if (!text) return null
  const out = decodeEntities(text).replace(/\s+/g, ' ').trim().slice(0, max)
  return out || null
}

/** `<meta property="og:title" content="…">`, either attribute order, either quote. */
function metaContent(html: string, key: string): string | null {
  const named = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)\\s*=\\s*["']${named}["'][^>]*?content\\s*=\\s*["']([^"']*)["']`,
      'i',
    ),
    new RegExp(
      `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*?(?:property|name)\\s*=\\s*["']${named}["']`,
      'i',
    ),
  ]
  for (const pattern of patterns) {
    const found = pattern.exec(html)
    if (found?.[1]) return found[1]
  }
  return null
}

export interface UnfurlResult {
  /** The address that actually answered, after every redirect this followed. */
  url: string
  title: string | null
  description: string | null
  siteName: string | null
}

/**
 * What an HTML page says about itself.
 *
 * Open Graph first because it is what a page puts there deliberately, `<title>` and the description
 * meta as the fallback, and the hostname as the site of last resort — a card with an address and
 * nothing else is still a card, and it is what the renderer draws when there is no title at all.
 */
export function metadataFrom(html: string, url: URL): UnfurlResult {
  const head = html.split(/<\/head\s*>/i)[0] ?? html
  const titleTag = /<title[^>]*>([\s\S]{0,400}?)<\/title\s*>/i.exec(head)?.[1] ?? null
  return {
    url: url.href,
    title:
      clean(metaContent(head, 'og:title'), PAGE_EMBED_MAX_TITLE) ??
      clean(metaContent(head, 'twitter:title'), PAGE_EMBED_MAX_TITLE) ??
      clean(titleTag?.replace(/<[^>]*>/g, ''), PAGE_EMBED_MAX_TITLE),
    description:
      clean(metaContent(head, 'og:description'), PAGE_EMBED_MAX_DESCRIPTION) ??
      clean(metaContent(head, 'description'), PAGE_EMBED_MAX_DESCRIPTION),
    siteName:
      clean(metaContent(head, 'og:site_name'), PAGE_EMBED_MAX_SITE) ??
      clean(url.hostname, PAGE_EMBED_MAX_SITE),
  }
}

/* ---------------------------------------------------------------------------------------------- */
/* The whole thing                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Fetch a URL and read what it says about itself, or refuse and say which rule refused it.
 *
 * The redirect loop is the part worth reading. Every hop — including the first — goes through
 * `checkTarget` *before* it is requested, so a 302 from a public site to `http://127.0.0.1:4000` is
 * refused at the second check, with the second request never made. That is the only arrangement
 * that works: an HTTP client following redirects on its own has already made the request by the
 * time anything here could look at where it went.
 */
export async function unfurl(rawUrl: string, policy: UnfurlPolicy): Promise<UnfurlResult> {
  const full: Required<UnfurlPolicy> = {
    allowHosts: policy.allowHosts,
    maxRedirects: policy.maxRedirects ?? DEFAULT_REDIRECTS,
    timeoutMs: policy.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: policy.maxBytes ?? DEFAULT_MAX_BYTES,
    resolve: policy.resolve ?? resolveWithDns,
    hop: policy.hop ?? httpHop,
  }

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new UnfurlRefused('bad_url')
  }

  const deadline = Date.now() + full.timeoutMs
  for (let redirects = 0; redirects <= full.maxRedirects; redirects++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new UnfurlRefused('unreachable')
    const addresses = await checkTarget(url, full)
    const answer = await full.hop(url, addresses, { ...full, timeoutMs: remaining })

    if (answer.status >= 300 && answer.status < 400 && answer.location) {
      let next: URL
      try {
        next = new URL(answer.location, url)
      } catch {
        throw new UnfurlRefused('bad_url')
      }
      url = next
      continue
    }
    if (answer.status < 200 || answer.status >= 300) throw new UnfurlRefused('not_readable')
    if (!answer.body) {
      // Nothing to read, but the address answered: a card with the URL on it is still honest.
      return { url: url.href, title: null, description: null, siteName: url.hostname }
    }
    return metadataFrom(answer.body, url)
  }
  throw new UnfurlRefused('too_many_redirects')
}

/* ---------------------------------------------------------------------------------------------- */
/* The service                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

/** How long an answer is kept. A headline does not change in ten minutes, and a page render is hot. */
const CACHE_TTL_MS = 10 * 60_000
const CACHE_MAX = 500

interface CacheEntry {
  at: number
  value: UnfurlResult
}

/**
 * The words a refusal is reported with.
 *
 * Two of the eight are an *operator's* problem rather than the writer's, and they get their own
 * sentence: somebody pasting a link into a page cannot be expected to work out that an environment
 * variable is empty, and "that address is not allowed" would send them looking for a typo.
 */
const REFUSAL_MESSAGES: Record<UnfurlRefusal, string> = {
  no_allowlist:
    'No sites have been allowed for embedding on this instance. An administrator sets QUIRE_EMBED_HOSTS.',
  not_allowed: 'This site is not one of the sites allowed for embedding on this instance.',
  private_address: 'That address is on a private network, so it will not be fetched.',
  unresolvable: 'That address could not be resolved.',
  bad_url: 'That is not a web address that can be embedded.',
  too_many_redirects: 'That address redirected too many times.',
  unreachable: 'That site did not answer.',
  not_readable: 'That page could not be read.',
}

export function quireUnfurl(kernel: Kernel) {
  const cache = new Map<string, CacheEntry>()

  /*
   * Read on every call rather than at boot, so an operator who sets the variable and restarts one
   * process does not have to wonder which of them picked it up — and so a test can set it.
   */
  const allowHosts = () => parseHostAllowlist(process.env.QUIRE_EMBED_HOSTS)

  return {
    allowHosts,

    /**
     * Unfurl one address, refusing with a sentence rather than a stack trace.
     *
     * Cached by the URL the writer typed. The cache is per process and small: it exists so that a
     * page whose writer pastes the same link twice is one request, not so that an unfurl is free.
     */
    async get(rawUrl: string): Promise<UnfurlResult> {
      const key = rawUrl.trim()
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value

      try {
        const value = await unfurl(key, { allowHosts: allowHosts() })
        if (cache.size >= CACHE_MAX) cache.clear()
        cache.set(key, { at: Date.now(), value })
        return value
      } catch (err) {
        if (err instanceof UnfurlRefused) {
          /*
           * Logged at info rather than warn: a refusal is this working, and a workspace with a
           * strict allow-list would otherwise fill an operator's log with warnings about the
           * feature behaving exactly as configured.
           */
          kernel.log.info({ refusal: err.refusal }, 'quire: refused to unfurl an address')
          throw new KernError('BAD_REQUEST', REFUSAL_MESSAGES[err.refusal])
        }
        throw err
      }
    },
  }
}

export type QuireUnfurl = ReturnType<typeof quireUnfurl>
