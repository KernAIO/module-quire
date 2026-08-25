import { getHost } from '@kernhq/ui'
import { createQuireClient, type QuireApi } from './index.js'
import { createMockQuireApi } from './mock.js'

/**
 * This module's API client.
 *
 * An empty base URL keeps requests same-origin, so the dev proxy and the reverse proxy both work
 * without CORS. `PUBLIC_API_MOCK=1` swaps in the in-memory implementation, which satisfies the same
 * contract types — so no screen has a second code path for demos and end-to-end tests.
 */
export type { QuireApi }

let cached: QuireApi | null = null

export function getQuireApi(): QuireApi {
  if (cached) return cached
  cached = getHost().isMock
    ? (createMockQuireApi() as unknown as QuireApi)
    : createQuireClient({
        baseUrl: getHost().apiBaseUrl,
      })
  return cached
}

/** Test seam. */
export function __setQuireApi(api: QuireApi | null) {
  cached = api
}
