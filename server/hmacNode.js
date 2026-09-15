import { createHmac, timingSafeEqual } from 'node:crypto'

export function signBody(secret, body) {
  return createHmac('sha256', secret).update(body).digest('hex')
}

export function verifyHmac(secret, body, header) {
  if (!secret) return false
  const got = String(header || '').replace(/^sha256=/i, '')
  if (!/^[0-9a-f]+$/i.test(got)) return false
  const exp = signBody(secret, body)
  const a = Buffer.from(got, 'hex')
  const b = Buffer.from(exp, 'hex')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Lithic Events API / ASA webhook verification (Svix-style).
 * Rejects timestamps outside `toleranceSec` to stop replays, as Lithic recommends.
 */
export function verifyLithicWebhook(secret, rawBody, headers = {}, { now = Date.now() / 1000, toleranceSec = 300 } = {}) {
  if (!secret) return { ok: false, reason: 'no-secret' }
  let key = String(secret)
  if (key.startsWith('whsec_')) key = key.slice('whsec_'.length)
  const decoded = Buffer.from(key, 'base64')
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), v]))
  const id = h['webhook-id']
  const ts = h['webhook-timestamp']
  const sigHeader = String(h['webhook-signature'] || '')
  if (!id || !ts || !sigHeader) return { ok: false, reason: 'missing-headers' }
  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > toleranceSec) return { ok: false, reason: 'stale-timestamp' }
  const signed = `${id}.${ts}.${rawBody}`
  const digest = createHmac('sha256', decoded).update(signed).digest('base64')
  const expected = Buffer.from(digest)
  for (const part of sigHeader.split(/\s+/)) {
    const got = part.replace(/^v\d+,/, '')
    const actual = Buffer.from(got)
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
      return { ok: true }
    }
  }
  return { ok: false, reason: 'bad-signature' }
}
