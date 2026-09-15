import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
export const SESSION_COOKIE = 'stipend_session'

export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(String(password), salt, 64)
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored || '').split('$')
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false
  const expected = Buffer.from(hashB64, 'base64')
  const actual = scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length)
  return timingSafeEqual(actual, expected)
}

export function generatePassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(16)
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('')
}

export function passwordProblem(password) {
  if (String(password || '').length < 10) return 'Password must be at least 10 characters.'
  return null
}

export function createSessions({ ttlMs = SESSION_TTL_MS } = {}) {
  const sessions = new Map()
  return {
    create(user) {
      const token = randomBytes(32).toString('base64url')
      sessions.set(token, { userId: user.id, expires: Date.now() + ttlMs })
      return token
    },
    get(token) {
      const row = token && sessions.get(token)
      if (!row) return null
      if (row.expires < Date.now()) {
        sessions.delete(token)
        return null
      }
      row.expires = Date.now() + ttlMs
      return row
    },
    destroy(token) {
      sessions.delete(token)
    },
    destroyUser(userId, keep) {
      for (const [token, row] of sessions) if (row.userId === userId && token !== keep) sessions.delete(token)
    },
  }
}

export function createRateLimiter({ windowMs = 60_000, max = 5 } = {}) {
  const hits = new Map()
  return {
    allow(key) {
      const now = Date.now()
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs)
      recent.push(now)
      hits.set(key, recent)
      return recent.length <= max
    },
  }
}

export function parseCookies(header = '') {
  return Object.fromEntries(
    String(header)
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([k, v]) => k && v !== undefined)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
  )
}

export function sessionCookie(token, { secure = false, maxAgeMs = SESSION_TTL_MS } = {}) {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}
