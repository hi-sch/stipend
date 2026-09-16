import { createHash, randomBytes } from 'node:crypto'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

// Only the hash of a session token is stored. A stolen database backup cannot be used to
// impersonate anyone, because the tokens themselves were never written down.
const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex')

/**
 * Sessions in Postgres, so they survive a restart and are shared across replicas: a
 * cardholder signed in through one pod stays signed in when the next request lands on
 * another.
 */
export function createSessionStore(db, { ttlMs = SESSION_TTL_MS } = {}) {
  return {
    async create(user, { ip = null, userAgent = null } = {}) {
      const token = randomBytes(32).toString('base64url')
      await db.query(
        `INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent)
         VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval, $4, $5)`,
        [hashToken(token), user.id, String(ttlMs), ip, userAgent],
      )
      return token
    },

    /** Returns the session and slides its expiry, or null when it is unknown or expired. */
    async get(token) {
      if (!token) return null
      const hash = hashToken(token)

      const { rows } = await db.query(
        `UPDATE sessions
            SET expires_at = now() + ($2 || ' milliseconds')::interval
          WHERE token_hash = $1 AND expires_at > now()
          RETURNING user_id, expires_at`,
        [hash, String(ttlMs)],
      )
      if (rows.length) return { userId: rows[0].user_id, expires: rows[0].expires_at }

      // Nothing was updated: either it never existed or it has lapsed. Clear it either way.
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [hash])
      return null
    },

    async destroy(token) {
      if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)])
    },

    async countForUser(userId) {
      const { rows } = await db.query('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND expires_at > now()', [userId])
      return rows[0].n
    },

    /** Sign out everywhere else. Used on password change and by "sign out other devices". */
    async destroyUser(userId, keepToken) {
      await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, keepToken ? hashToken(keepToken) : ''])
    },

    async purgeExpired() {
      const { rowCount } = await db.query('DELETE FROM sessions WHERE expires_at < now()')
      return rowCount
    },
  }
}
