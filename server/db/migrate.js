import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPool } from './pool.js'

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

// Every process that starts takes this lock before migrating. Several pods rolling out at
// once will queue here instead of applying the same file twice.
const LOCK_KEY = 8273461

/** Migration files are `NNN_name.sql`, applied in filename order, each exactly once. */
export function listMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ version: name.replace(/\.sql$/, ''), name, path: join(dir, name) }))
}

/**
 * Apply pending migrations. Each file runs inside its own transaction, so a failure
 * leaves the database on the last complete migration rather than half-way through one.
 */
export async function migrate({ db, dir = MIGRATIONS_DIR, log } = {}) {
  const applied = []

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const client = await db.pool.connect()
  try {
    // Held on purpose for as long as the migrations take, and idle between them. The pool's
    // leak detector is told so, and the session opts out of any server-side idle timeout:
    // losing this connection would drop the advisory lock below and let a second replica
    // start applying the same migration.
    db.untrack?.(client)
    await client.query('SET idle_session_timeout = 0').catch(() => {})

    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])

    const { rows } = await client.query('SELECT version FROM schema_migrations')
    const done = new Set(rows.map((r) => r.version))

    for (const migration of listMigrations(dir)) {
      if (done.has(migration.version)) continue
      const sql = readFileSync(migration.path, 'utf8')
      log?.info?.('applying migration', { version: migration.version })
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [migration.version])
        await client.query('COMMIT')
        applied.push(migration.version)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw new Error(`migration ${migration.version} failed: ${err.message}`, { cause: err })
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    client.release()
  }

  return applied
}

// `node server/db/migrate.js` applies pending migrations and exits. Used by the container
// entrypoint and by the test harness.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool({ url: process.env.DATABASE_URL, max: 2, applicationName: 'stipend-migrate' })
  try {
    const applied = await migrate({ db, log: { info: (m, f) => console.log(m, f) } })
    console.log(applied.length ? `applied ${applied.length} migration(s): ${applied.join(', ')}` : 'database is up to date')
  } catch (err) {
    console.error(err.message)
    process.exitCode = 1
  } finally {
    await db.end()
  }
}
