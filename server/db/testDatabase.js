import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { createPool } from './pool.js'
import { migrate } from './migrate.js'

/**
 * A database of the test file's own.
 *
 * Tests that write have to work somewhere nobody else is using. DATABASE_URL is usually a
 * development database with real work in it, and a test that seeds fixtures there leaves
 * them behind: a program-wide assertion then sees another file's cardholders, and whoever
 * owns the database finds it full of strangers.
 *
 * node --test gives each file its own process, so one database per file is the natural
 * grain.
 */
export async function createTestDatabase(label) {
  const adminUrl = process.env.DATABASE_URL
  if (!adminUrl) return null

  const name = `stipend_t_${label}_${randomUUID().slice(0, 8).replace(/-/g, '')}`
  const admin = new pg.Client({ connectionString: adminUrl })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()

  const url = adminUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`)
  const db = createPool({ url, max: 2 })
  await migrate({ db })
  await db.end()

  return { url, name }
}

export async function dropTestDatabase(name) {
  if (!name || !process.env.DATABASE_URL) return
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL })
  await admin.connect()
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
  await admin.end()
}
