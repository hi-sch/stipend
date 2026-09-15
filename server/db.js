import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const SESSION_TTL_MS = 12 * 60 * 60 * 1000

/**
 * SQLite-backed store. Application state is one JSON document updated inside
 * BEGIN IMMEDIATE transactions, so several server processes can share the file without
 * losing writes. Sessions and the audit log are separate tables. WAL mode, daily backups.
 */
export function createDb({ file, seed, legacyJsonFile, backupDir, log, pollMs = 1000 }) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const sql = new DatabaseSync(file)
  sql.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, data TEXT NOT NULL, updated TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, outcome TEXT NOT NULL, details TEXT, ip TEXT);
    CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)

  const q = {
    get: sql.prepare('SELECT version, data FROM state WHERE id = 1'),
    version: sql.prepare('SELECT version FROM state WHERE id = 1'),
    insert: sql.prepare('INSERT INTO state (id, version, data, updated) VALUES (1, ?, ?, ?)'),
    update: sql.prepare('UPDATE state SET version = ?, data = ?, updated = ? WHERE id = 1'),
    metaGet: sql.prepare('SELECT value FROM meta WHERE key = ?'),
    metaSet: sql.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  }

  let cache = null
  const listeners = new Set()

  function load() {
    const row = q.get.get()
    cache = row ? { ...JSON.parse(row.data), version: row.version } : null
    return cache
  }

  function transaction(fn) {
    sql.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      sql.exec('COMMIT')
      return result
    } catch (err) {
      sql.exec('ROLLBACK')
      throw err
    }
  }

  if (!load()) {
    let initial = null
    if (legacyJsonFile && existsSync(legacyJsonFile)) {
      initial = JSON.parse(readFileSync(legacyJsonFile, 'utf8'))
      renameSync(legacyJsonFile, `${legacyJsonFile}.migrated`)
      log?.info?.('migrated JSON store to SQLite', { from: legacyJsonFile })
    } else {
      initial = seed()
    }
    const { version, ...data } = initial
    q.insert.run(0, JSON.stringify(data), new Date().toISOString())
    load()
  }

  function notify(version) {
    for (const listener of listeners) listener(version)
  }

  // Other processes may write; poll the version so SSE clients everywhere refresh.
  let lastSeen = cache.version
  const poller = pollMs
    ? setInterval(() => {
        const row = q.version.get()
        if (row && row.version !== lastSeen) {
          lastSeen = row.version
          load()
          notify(row.version)
        }
      }, pollMs)
    : null
  poller?.unref?.()

  const db = {
    read() {
      const row = q.version.get()
      if (!cache || row.version !== cache.version) load()
      return cache
    },
    mutate(fn) {
      const { result, version } = transaction(() => {
        const current = load()
        const draft = structuredClone(current)
        const out = fn(draft)
        const next = current.version + 1
        const { version: _ignored, ...data } = draft
        q.update.run(next, JSON.stringify(data), new Date().toISOString())
        return { result: out, version: next }
      })
      load()
      lastSeen = version
      notify(version)
      return result
    },
    replace(next) {
      const version = transaction(() => {
        const current = load()
        const { version: _ignored, ...data } = next
        q.update.run(current.version + 1, JSON.stringify(data), new Date().toISOString())
        return current.version + 1
      })
      load()
      lastSeen = version
      notify(version)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    sessions: createSessionStore(sql),

    audit(entry) {
      sql
        .prepare('INSERT INTO audit (at, actor, action, target, outcome, details, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(entry.at || new Date().toISOString(), entry.actor || 'system', entry.action, entry.target ?? null, entry.outcome || 'ok', entry.details ? JSON.stringify(entry.details) : null, entry.ip ?? null)
    },
    auditList({ limit = 100, before, actor, action } = {}) {
      const where = []
      const args = []
      if (before) {
        where.push('id < ?')
        args.push(Number(before))
      }
      if (actor) {
        where.push('actor = ?')
        args.push(actor)
      }
      if (action) {
        where.push('action LIKE ?')
        args.push(`%${action}%`)
      }
      const rows = sql
        .prepare(`SELECT * FROM audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
        .all(...args, Math.min(500, Math.max(1, Number(limit) || 100)))
      return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }))
    },

    backup({ dir = backupDir, keep = 7 } = {}) {
      if (!dir || file === ':memory:') return null
      mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = join(dir, `${basename(file, '.sqlite')}-${stamp}-${randomBytes(3).toString('hex')}.sqlite`)
      sql.prepare('VACUUM INTO ?').run(target)
      q.metaSet.run('lastBackupAt', new Date().toISOString())
      const old = listBackups(dir).slice(keep)
      for (const b of old) rmSync(join(dir, b.name), { force: true })
      return target
    },
    backups: (dir = backupDir) => (dir && existsSync(dir) ? listBackups(dir) : []),
    lastBackupAt: () => q.metaGet.get('lastBackupAt')?.value || null,

    close() {
      if (poller) clearInterval(poller)
      sql.close()
    },
  }
  return db
}

function listBackups(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sqlite'))
    .map((name) => ({ name, size: statSync(join(dir, name)).size, created: statSync(join(dir, name)).mtime.toISOString() }))
    .sort((a, b) => b.created.localeCompare(a.created))
}

const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex')

/** Sessions persist across restarts and processes; only token hashes are stored. */
function createSessionStore(sql, ttlMs = SESSION_TTL_MS) {
  const insert = sql.prepare('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)')
  const get = sql.prepare('SELECT user_id, expires FROM sessions WHERE token_hash = ?')
  const touch = sql.prepare('UPDATE sessions SET expires = ? WHERE token_hash = ?')
  const remove = sql.prepare('DELETE FROM sessions WHERE token_hash = ?')
  const purge = sql.prepare('DELETE FROM sessions WHERE expires < ?')
  return {
    create(user) {
      const token = randomBytes(32).toString('base64url')
      insert.run(hashToken(token), user.id, Date.now(), Date.now() + ttlMs)
      return token
    },
    get(token) {
      if (!token) return null
      const hash = hashToken(token)
      const row = get.get(hash)
      if (!row) return null
      if (row.expires < Date.now()) {
        remove.run(hash)
        return null
      }
      touch.run(Date.now() + ttlMs, hash)
      return { userId: row.user_id, expires: row.expires }
    },
    destroy(token) {
      if (token) remove.run(hashToken(token))
    },
    countForUser(userId) {
      return sql.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires > ?').get(userId, Date.now()).n
    },
    destroyUser(userId, keepToken) {
      const keep = keepToken ? hashToken(keepToken) : ''
      sql.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keep)
    },
    purgeExpired() {
      purge.run(Date.now())
    },
  }
}
