const SANDBOX = 'https://sandbox.lithic.com'
const PRODUCTION = 'https://api.lithic.com'

export class LithicError extends Error {
  constructor(message, status, payload) {
    super(message)
    this.status = status
    this.payload = payload
  }
}

export function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''))
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Minimal Lithic REST client. Requests run one at a time so sandbox rate limits
 * (and auth-rule draft/promote ordering) stay predictable.
 */
export function createLithic({ apiKey, environment = 'sandbox', fetchImpl = fetch } = {}) {
  const origin = environment === 'production' ? PRODUCTION : SANDBOX
  let queue = Promise.resolve()

  async function once(method, path, body, { idempotencyKey } = {}) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const res = await fetchImpl(`${origin}${path}`, {
        method,
        headers: {
          Authorization: apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      let data = {}
      try {
        data = text ? JSON.parse(text) : {}
      } catch {
        data = { message: text }
      }
      if (res.status === 429) {
        await sleep(Math.max(Number(res.headers.get('retry-after') || 1) * 1000, 1000))
        continue
      }
      if (!res.ok) throw new LithicError(data.message || data.error || `Lithic ${res.status}`, res.status, data)
      return data
    }
    throw new LithicError('Lithic rate limit: too many retries', 429)
  }

  function call(method, path, body, opts) {
    if (!apiKey) return Promise.reject(new LithicError('LITHIC_API_KEY is not set', 503))
    const run = () => once(method, path, body, opts)
    const next = queue.then(run, run)
    queue = next.catch(() => {})
    return next
  }

  return {
    configured: Boolean(apiKey),
    environment,
    origin,
    call,
    get: (path) => call('GET', path),
    post: (path, body, opts) => call('POST', path, body, opts),
    patch: (path, body) => call('PATCH', path, body),
    del: (path) => call('DELETE', path),
  }
}

export function qs(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}
