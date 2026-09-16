import pg from 'pg'

const { Pool, types } = pg

// Money is bigint cents. node-postgres hands back int8 as a string so it cannot lose
// precision silently; every amount in this schema is well inside Number.MAX_SAFE_INTEGER,
// so parse them to numbers and keep the rest of the code working in plain integers.
types.setTypeParser(20, (value) => (value === null ? null : Number(value)))

// Timestamps travel as ISO strings, the same shape the JSON document used, so the API
// payload and the frontend contract do not change.
const TIMESTAMPTZ = 1184
const TIMESTAMP = 1114
types.setTypeParser(TIMESTAMPTZ, (value) => (value === null ? null : new Date(value).toISOString()))
types.setTypeParser(TIMESTAMP, (value) => (value === null ? null : new Date(`${value}Z`).toISOString()))

// Postgres retries: a serialization failure or deadlock means "try the whole transaction
// again", not "the write is invalid".
const RETRYABLE = new Set(['40001', '40P01'])

/**
 * Connection pool and transaction helper.
 *
 * This replaces the single-document store. There is no global write lock any more: a
 * transaction locks only the rows it touches, so two authorizations for different
 * cardholders no longer serialize behind each other.
 */
// Long enough that nothing legitimate trips it: resetting the program deletes everything and
// reseeds inside one transaction, and reconciliation resolves every break inside another, so
// both hold a client for minutes by design. A leaked connection is held for the life of the
// process, so five minutes catches it just as surely as one would — and a warning that fires
// during normal work is how people learn to ignore the warning that matters.
const LEAK_AFTER_MS = 5 * 60_000

export function createPool({ url, max = 10, log, statementTimeoutMs = 10_000, applicationName = 'stipend', leakAfterMs = LEAK_AFTER_MS } = {}) {
  if (!url) throw new Error('DATABASE_URL is not set.')

  const pool = new Pool({
    connectionString: url,
    max,
    application_name: applicationName,
    statement_timeout: statementTimeoutMs,
    // A pod that loses its database should fail its readiness probe, not hang forever.
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  })

  // An idle client erroring out must never take the process down with it.
  pool.on('error', (err) => log?.error?.('database pool error', { err: err.message }))

  /**
   * Who is holding a connection, and since when.
   *
   * idleTimeoutMillis only reaps clients that are idle *in the pool*. A client that was
   * checked out and never released is invisible to it, and to the pool's own counts: it
   * shows as an idle backend in Postgres and stays there for the life of the process. A
   * development server was once found holding 102 connections against a maximum of 10, and
   * there was no way to tell which code path had taken them — that is what this is for.
   *
   * The stack is captured at checkout, so the warning names the caller rather than the
   * sweep. Each client is reported once; the point is to name it, not to fill the log.
   */
  const heldClients = new Map()

  const nativeConnect = pool.connect.bind(pool)
  pool.connect = (...args) => {
    // pool.query() checks out internally in callback style and gives the connection straight
    // back. That path is left exactly as it was: it is not where a connection goes missing,
    // and returning a promise for it breaks every query in the program.
    if (typeof args[0] === 'function') return nativeConnect(...args)

    return nativeConnect(...args).then((client) => {
      heldClients.set(client, { at: Date.now(), where: new Error('connection checked out here').stack, warned: false })

      // node-postgres hands the same client object back on a later checkout, so the patch is
      // reapplied each time and removed on release rather than left in place.
      const release = client.release
      client.release = (...rest) => {
        heldClients.delete(client)
        client.release = release
        return release.apply(client, rest)
      }
      return client
    })
  }

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [, held] of heldClients) {
      if (held.warned || now - held.at < leakAfterMs) continue
      held.warned = true
      log?.warn?.('a database connection has been held open far too long', { heldMs: now - held.at, where: held.where })
    }
  }, Math.max(1_000, Math.floor(leakAfterMs / 2)))
  sweep.unref?.()

  async function query(text, params) {
    return pool.query(text, params)
  }

  /**
   * Run fn inside one transaction. fn receives a client whose query() is the only way to
   * touch the database, so a caller cannot accidentally escape the transaction.
   *
   * Retries serialization failures and deadlocks with a short backoff. fn must therefore
   * be free of outside side effects — no email, no Lithic call — because it may run twice.
   */
  async function tx(fn, { isolation = 'READ COMMITTED', retries = 3 } = {}) {
    let attempt = 0
    for (;;) {
      const client = await pool.connect()
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`)
        const result = await fn(client)
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        if (RETRYABLE.has(err.code) && attempt < retries) {
          attempt += 1
          log?.warn?.('retrying transaction', { code: err.code, attempt })
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt))
          continue
        }
        throw err
      } finally {
        client.release()
      }
    }
  }

  /** True when the database answers. Backs the readiness probe. */
  async function healthy() {
    try {
      await pool.query('SELECT 1')
      return true
    } catch {
      return false
    }
  }

  return {
    query,
    tx,
    healthy,
    pool,

    /**
     * Say that a connection is meant to be held.
     *
     * The version stream keeps one connection listening for the life of the process, and a
     * migration holds one for as long as the migrations take. Both are deliberate, so they
     * opt out rather than being reported every sweep — which would train everyone to ignore
     * the one warning that matters.
     */
    untrack: (client) => heldClients.delete(client),

    /** Connections checked out right now, and how long the oldest has been held. */
    heldStats: () => {
      const now = Date.now()
      let oldestMs = 0
      for (const [, held] of heldClients) oldestMs = Math.max(oldestMs, now - held.at)
      return { held: heldClients.size, oldestMs }
    },

    end: () => {
      clearInterval(sweep)
      return pool.end()
    },
  }
}
