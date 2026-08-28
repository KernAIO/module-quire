import { createServer, type Server } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkTarget,
  hostAllowed,
  httpHop,
  isPublicAddress,
  metadataFrom,
  parseHostAllowlist,
  UnfurlRefused,
  unfurl,
} from './services/unfurl.js'

/**
 * The attacks, written down as tests, because this is the one thing in the module that makes the
 * server fetch an address a user chose.
 *
 * On the host this runs on, `127.0.0.1:4000` is core's API and `127.0.0.1:5432` is Postgres; on a
 * cloud instance `169.254.169.254` hands out credentials to anything that asks. Every one of those
 * is reachable from this process and from nothing else the user can talk to, which is what makes an
 * unfurl worth attacking and worth this file.
 *
 * Two properties are worth more than the rest and are asserted directly rather than inferred:
 *
 *   - **A redirect is refused after the hop is seen and before it is requested.** The first response
 *     is public and the second is the loopback interface; a client that follows redirects itself has
 *     already made the second request by the time anything could look at it. The test counts the
 *     requests to prove the second was never made.
 *   - **A hostname that resolves into private space is refused**, which no name-based check can do
 *     and which is the reason the address rule runs after DNS rather than before it.
 */

const refusal = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn()
    return 'allowed'
  } catch (err) {
    return err instanceof UnfurlRefused ? err.refusal : `threw ${String(err)}`
  }
}

/** An allow-list generous enough that nothing below is refused merely for not being on it. */
const ALLOW = ['example.com', '.example.com', 'evil.test', 'first.test', 'second.test', 'localhost']

describe('the address rule', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'the rest of 127/8'],
    ['0.0.0.0', 'every local interface, on Linux'],
    ['0.1.2.3', '0/8'],
    ['10.0.0.7', 'private'],
    ['172.16.4.4', 'private'],
    ['172.31.255.255', 'the top of 172.16/12'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'the cloud metadata service'],
    ['169.254.0.1', 'link-local'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.0.1', 'IETF protocol assignments'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'the unspecified address'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'the same, written in hex'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata service'],
    ['64:ff9b::7f00:1', 'NAT64 loopback'],
    ['2002:7f00:1::', '6to4 loopback'],
    ['fd00::1', 'unique local'],
    ['fe80::1', 'link-local'],
    ['ff02::1', 'multicast'],
    ['0100::1', 'discard-only'],
    ['not-an-address', 'something this cannot parse at all'],
    ['', 'nothing'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '2a00:1450::1'])(
    'allows %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )
})

describe('the allow-list', () => {
  it('is empty until an operator writes one, and empty refuses everything', async () => {
    expect(parseHostAllowlist(undefined)).toEqual([])
    expect(parseHostAllowlist('')).toEqual([])
    expect(await refusal(() => checkTarget(new URL('https://example.com/a'), { allowHosts: [] }))).toBe(
      'no_allowlist',
    )
  })

  it('reads a list however an operator spaced it', () => {
    expect(parseHostAllowlist('Example.com, .github.com\n  docs.rs. ')).toEqual([
      'example.com',
      '.github.com',
      'docs.rs',
    ])
  })

  it('matches a host exactly, and a subtree only where the entry asked for one', () => {
    expect(hostAllowed('example.com', ['example.com'])).toBe(true)
    expect(hostAllowed('EXAMPLE.COM.', ['example.com'])).toBe(true)
    // Without a leading dot, a subdomain is a different host — which is the point of an allow-list.
    expect(hostAllowed('evil.example.com', ['example.com'])).toBe(false)
    expect(hostAllowed('evil.example.com', ['.example.com'])).toBe(true)
    expect(hostAllowed('example.com', ['.example.com'])).toBe(true)
    // …and not a host that merely ends with the same letters.
    expect(hostAllowed('notexample.com', ['.example.com'])).toBe(false)
    expect(hostAllowed('example.com.evil.test', ['example.com'])).toBe(false)
  })
})

describe('the addresses a user can ask the server to fetch', () => {
  /** Never consulted: every case below must be refused before anything is resolved or requested. */
  const never = {
    allowHosts: ALLOW,
    resolve: async () => {
      throw new Error('resolved a host that should have been refused first')
    },
    hop: async () => {
      throw new Error('made a request that should have been refused first')
    },
  }

  it.each([
    ['http://127.0.0.1:4000/api/health', 'core, on this very host'],
    ['http://127.0.0.1:5432/', 'Postgres'],
    ['http://[::1]:4000/', 'the same over IPv6'],
    ['http://169.254.169.254/latest/meta-data/', 'the cloud metadata service'],
    ['http://0.0.0.0:4000/', 'every local interface'],
    ['http://[::ffff:127.0.0.1]:4000/', 'an IPv4-mapped loopback literal'],
    ['http://10.0.0.1/', 'a private network'],
  ])('refuses %s (%s)', async (url) => {
    expect(await refusal(() => unfurl(url, never))).toBe('private_address')
  })

  /**
   * A decimal address is the same address.
   *
   * The WHATWG URL parser normalises `http://2130706433/` to `127.0.0.1` before anything here sees
   * it, which is why this passes — and why it is asserted rather than assumed: a check written
   * against the *string* somebody typed would let all four spellings through.
   */
  it.each([
    ['http://2130706433/', 'decimal'],
    ['http://0x7f000001/', 'hexadecimal'],
    ['http://0177.0.0.1/', 'octal'],
    ['http://127.1/', 'the short form'],
  ])('refuses %s, which is 127.0.0.1 written as %s', async (url) => {
    expect(new URL(url).hostname).toBe('127.0.0.1')
    expect(await refusal(() => unfurl(url, never))).toBe('private_address')
  })

  it('refuses localhost, which is a name for the same thing', async () => {
    const resolve = async () => ['127.0.0.1']
    expect(await refusal(() => unfurl('http://localhost:4000/', { ...never, resolve }))).toBe(
      'private_address',
    )
  })

  /**
   * The attack a name-based check cannot see, and the reason the address rule runs after DNS.
   *
   * `evil.test` is a perfectly ordinary hostname, on the allow-list, that answers with the loopback
   * address. Nothing about the URL says so.
   */
  it('refuses a hostname that resolves to the loopback address', async () => {
    const resolve = async () => ['127.0.0.1']
    expect(await refusal(() => unfurl('https://evil.test/page', { ...never, resolve }))).toBe(
      'private_address',
    )
  })

  /** One public answer among private ones is not a public host: every address has to pass. */
  it('refuses a hostname where only some of the addresses are public', async () => {
    const resolve = async () => ['93.184.216.34', '127.0.0.1']
    expect(await refusal(() => unfurl('https://evil.test/page', { ...never, resolve }))).toBe(
      'private_address',
    )
  })

  it('refuses a scheme that is not http or https', async () => {
    for (const url of ['file:///etc/passwd', 'gopher://example.com/', 'data:text/html,<b>x</b>'])
      expect(await refusal(() => unfurl(url, never)), url).toBe('bad_url')
  })

  /** Credentials in a URL are sent to the host, and a URL carrying them is not one to follow. */
  it('refuses a URL carrying credentials', async () => {
    expect(await refusal(() => unfurl('https://user:secret@example.com/', never))).toBe('bad_url')
  })

  it('refuses a host nobody allowed, even though it is perfectly public', async () => {
    const resolve = async () => ['93.184.216.34']
    expect(await refusal(() => unfurl('https://not-allowed.test/', { ...never, resolve }))).toBe(
      'not_allowed',
    )
  })

  /**
   * The ordering that matters: the allow-list is checked **after** the address rule, never instead
   * of it. An entry an administrator added is not a way past the thing that keeps the server off
   * its own network — so an allowed host answering with 127.0.0.1 is refused as a private address,
   * not admitted as an allowed one.
   */
  it('does not let an allow-list entry override the address rule', async () => {
    const resolve = async () => ['127.0.0.1']
    expect(
      await refusal(() => checkTarget(new URL('https://example.com/'), { allowHosts: ALLOW, resolve })),
    ).toBe('private_address')
  })
})

describe('redirects', () => {
  /**
   * The whole point of following them by hand.
   *
   * The first response is public and says "look over there"; over there is core. The counter proves
   * the second request was never made — being refused *after* the answer is read and *before* the
   * next connection is opened is the only sequence that is safe, and a client following redirects
   * on its own cannot produce it.
   */
  it('refuses a public URL that redirects to the loopback interface, before requesting it', async () => {
    const asked: string[] = []
    const outcome = await refusal(() =>
      unfurl('https://first.test/go', {
        allowHosts: ALLOW,
        resolve: async (host) => (host === 'first.test' ? ['93.184.216.34'] : ['127.0.0.1']),
        hop: async (url) => {
          asked.push(url.href)
          return {
            status: 302,
            location: 'http://127.0.0.1:4000/api/health',
            contentType: null,
            body: '',
          }
        },
      }),
    )
    expect(outcome).toBe('private_address')
    expect(asked).toEqual(['https://first.test/go'])
  })

  it('re-checks the allow-list on every hop, not only the first', async () => {
    const asked: string[] = []
    const outcome = await refusal(() =>
      unfurl('https://first.test/go', {
        allowHosts: ['first.test'],
        resolve: async () => ['93.184.216.34'],
        hop: async (url) => {
          asked.push(url.href)
          return { status: 301, location: 'https://second.test/there', contentType: null, body: '' }
        },
      }),
    )
    expect(outcome).toBe('not_allowed')
    expect(asked).toEqual(['https://first.test/go'])
  })

  it('follows a redirect that stays inside the rules', async () => {
    const result = await unfurl('https://first.test/go', {
      allowHosts: ALLOW,
      resolve: async () => ['93.184.216.34'],
      hop: async (url) =>
        url.href === 'https://first.test/go'
          ? { status: 302, location: 'https://second.test/there', contentType: null, body: '' }
          : {
              status: 200,
              location: null,
              contentType: 'text/html',
              body: '<html><head><title>Arrived</title></head></html>',
            },
    })
    expect(result.url).toBe('https://second.test/there')
    expect(result.title).toBe('Arrived')
  })

  it('gives up rather than following a redirect loop for ever', async () => {
    let hops = 0
    const outcome = await refusal(() =>
      unfurl('https://first.test/a', {
        allowHosts: ALLOW,
        maxRedirects: 3,
        resolve: async () => ['93.184.216.34'],
        hop: async () => {
          hops++
          return { status: 302, location: 'https://first.test/a', contentType: null, body: '' }
        },
      }),
    )
    expect(outcome).toBe('too_many_redirects')
    expect(hops).toBe(4)
  })
})

describe('what it reads off a page', () => {
  const at = (html: string) => metadataFrom(html, new URL('https://example.com/a'))

  it('prefers Open Graph, which is what a page says about itself deliberately', () => {
    const meta = at(
      '<head><title>Tab title</title>' +
        '<meta property="og:title" content="The real headline">' +
        '<meta property="og:description" content="What it is about">' +
        '<meta property="og:site_name" content="Example"></head>',
    )
    expect(meta).toEqual({
      url: 'https://example.com/a',
      title: 'The real headline',
      description: 'What it is about',
      siteName: 'Example',
    })
  })

  it('falls back to the title tag, the description meta and the hostname', () => {
    const meta = at('<head><title>Just a title</title><meta name="description" content="A sentence."></head>')
    expect(meta.title).toBe('Just a title')
    expect(meta.description).toBe('A sentence.')
    expect(meta.siteName).toBe('example.com')
  })

  it('reads a meta tag whichever way round its attributes are written', () => {
    expect(at('<head><meta content="Backwards" property="og:title"></head>').title).toBe('Backwards')
  })

  it('decodes the entities a headline is written with', () => {
    expect(at('<head><title>AT&amp;T &#8212; news</title></head>').title).toBe('AT&T — news')
  })

  it('collapses whitespace and caps the length rather than storing a page in a card', () => {
    const long = 'x'.repeat(1000)
    const meta = at(`<head><title>a\n   b</title><meta name="description" content="${long}"></head>`)
    expect(meta.title).toBe('a b')
    expect((meta.description ?? '').length).toBe(400)
  })

  /**
   * Markup in a headline stays inert.
   *
   * The renderer escapes everything on the way out, so this is belt and braces — but the value is
   * also stored in a document and read back by an editor, and a title carrying a half-open tag is a
   * thing somebody has to notice rather than a thing nothing can do.
   */
  it('keeps markup in a title as text', () => {
    const meta = at('<head><meta property="og:title" content="&lt;script&gt;alert(1)&lt;/script&gt;"></head>')
    expect(meta.title).toBe('<script>alert(1)</script>')
  })

  it('reads nothing out of the body, only the head', () => {
    expect(at('<head><title>Head</title></head><body><title>Body</title></body>').title).toBe('Head')
  })
})

/*
 * The transport, against a real socket.
 *
 * `httpHop` carries no policy — it is one request, capped — so it is safe to point at a local
 * server, which is the only way to prove the byte cap and the timeout actually fire. The rules that
 * would stop `unfurl` reaching this address are tested above; here the address is the fixture.
 */
describe('one request, capped', () => {
  let server: Server
  let port = 0
  const policy = {
    allowHosts: ['localhost'],
    maxRedirects: 3,
    timeoutMs: 2_000,
    maxBytes: 4_096,
    resolve: async () => ['127.0.0.1'],
    hop: httpHop,
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.write('<head><title>Big</title></head>')
        // Far more than the cap, written in one go: the reader has to stop on its own.
        res.write('x'.repeat(400_000))
        res.end()
        return
      }
      if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.write('<head>')
        // Never finished, so only the deadline can end this.
        return
      }
      if (req.url === '/video') {
        res.writeHead(200, { 'content-type': 'video/mp4' })
        res.end('not html at all')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<head><title>Hello</title></head>')
    })
    await new Promise<void>((resolve) => server.listen(4617, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  const url = (path: string) => new URL(`http://127.0.0.1:${port}${path}`)

  it('reads a small page', async () => {
    const hop = await httpHop(url('/'), ['127.0.0.1'], policy)
    expect(hop.status).toBe(200)
    expect(metadataFrom(hop.body, url('/')).title).toBe('Hello')
  })

  it('stops reading at the cap rather than downloading whatever is offered', async () => {
    const hop = await httpHop(url('/big'), ['127.0.0.1'], policy)
    expect(hop.body.length).toBeLessThanOrEqual(policy.maxBytes)
    // What it did read is still enough to unfurl, which is the point of reading the head first.
    expect(metadataFrom(hop.body, url('/big')).title).toBe('Big')
  })

  it('gives up on a response that never ends', async () => {
    const outcome = await refusal(() => httpHop(url('/slow'), ['127.0.0.1'], { ...policy, timeoutMs: 300 }))
    expect(outcome).toBe('unreachable')
  })

  it('does not read a body that is not a page', async () => {
    const hop = await httpHop(url('/video'), ['127.0.0.1'], policy)
    expect(hop.body).toBe('')
  })

  it('refuses a connection nobody is listening on', async () => {
    const outcome = await refusal(() =>
      httpHop(new URL('http://127.0.0.1:4649/'), ['127.0.0.1'], { ...policy, timeoutMs: 500 }),
    )
    expect(outcome).toBe('unreachable')
  })
})
