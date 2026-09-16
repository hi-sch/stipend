/**
 * The version counter behind the browser's live updates.
 *
 * The SQLite store bumped a row version on every write and polled it once a second. That
 * cannot work across replicas: a browser connected to one pod would never learn about a
 * write made on another.
 *
 * Here the counter lives in program_meta and every bump sends a NOTIFY. Each pod holds one
 * dedicated LISTEN connection and fans the version out to its own Server-Sent Events
 * clients, so a write anywhere reaches every browser everywhere. The wire format the
 * frontend sees is unchanged: `event: version` with an integer.
 */

const CHANNEL = 'stipend_version'

/** Bump the counter and tell every listener. Called inside the writing transaction. */
export async function bumpVersion(client) {
  const { rows } = await client.query(
    `INSERT INTO program_meta (key, value, updated_at) VALUES ('version', '1'::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = to_jsonb(((program_meta.value #>> '{}')::bigint + 1)), updated_at = now()
     RETURNING value`,
  )
  const version = Number(rows[0].value)
  // NOTIFY is transactional: listeners are told only if this transaction commits.
  await client.query(`SELECT pg_notify('${CHANNEL}', $1)`, [String(version)])
  return version
}

export async function currentVersion(db) {
  const { rows } = await db.query(`SELECT (value #>> '{}')::bigint AS v FROM program_meta WHERE key = 'version'`)
  return Number(rows[0]?.v ?? 0)
}

/**
 * One LISTEN connection per process, shared by every SSE client it is serving.
 *
 * The connection is taken from the pool and never released while the process runs, so the
 * pool is sized with that in mind. If it drops, it is re-established: losing it silently
 * would leave every open browser stuck on a stale version with no visible error.
 */
export function createVersionStream({ db, log, reconnectMs = 2000 } = {}) {
  const listeners = new Set()
  let client = null
  let stopped = false
  let reconnecting = false

  async function connect() {
    if (stopped) return
    try {
      const next = await db.pool.connect()

      // The stream may have been stopped, or another reconnect may have won, while this
      // one waited on the pool. A client that is not the tracked one has to go back:
      // otherwise the pool fills with connections nobody is listening on, and eventually
      // no caller can acquire one at all.
      if (stopped || client) {
        try {
          next.release(true)
        } catch {
          // Already gone; nothing to release.
        }
        return
      }

      client = next

      // This connection is meant to sit idle: it listens and nothing else. Two consequences
      // are handled here rather than being surprises later. The pool's leak detector would
      // otherwise report it every sweep, and a server-side idle_session_timeout — which is
      // what bounds connections the application has lost track of — would terminate it on a
      // timer and leave the stream reconnecting for ever.
      db.untrack?.(next)
      await client.query('SET idle_session_timeout = 0').catch(() => {})

      client.on('notification', (msg) => {
        if (msg.channel !== CHANNEL) return
        const version = Number(msg.payload)
        for (const listener of listeners) {
          try {
            listener(version)
          } catch (err) {
            log?.warn?.('version listener failed', { err: err.message })
          }
        }
      })
      client.on('error', (err) => {
        log?.warn?.('version stream connection lost', { err: err.message })
        reconnect()
      })
      await client.query(`LISTEN ${CHANNEL}`)
      log?.info?.('listening for version changes')
    } catch (err) {
      log?.warn?.('version stream could not connect', { err: err.message })
      reconnect()
    }
  }

  function reconnect() {
    // One reconnect at a time.
    //
    // When the server drops its backends together — a failover, or someone clearing
    // connections by hand — every client in the pool raises 'error' at once, and each of
    // those used to start its own reconnect. They all awaited the pool, they all assigned
    // to `client`, and only the last assignment survived: the rest stayed checked out for
    // the life of the process. A handful of failovers was enough to strand the whole pool.
    if (reconnecting || stopped) return
    reconnecting = true

    const dying = client
    client = null
    try {
      dying?.release?.(true)
    } catch {
      // The connection is already gone; nothing to release.
    }

    const timer = setTimeout(() => {
      reconnecting = false
      connect()
    }, reconnectMs)
    timer.unref?.()
  }

  return {
    start: connect,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async stop() {
      stopped = true
      listeners.clear()
      try {
        await client?.query(`UNLISTEN ${CHANNEL}`)
      } catch {
        // Shutting down; an UNLISTEN that cannot be sent changes nothing.
      }
      client?.release?.()
      client = null
    },
  }
}
