import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDb } from './db.js'

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'stipend-db-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('writes from one connection are visible to another (multi-process safety)', () => {
  const { dir, done } = tmp()
  const file = join(dir, 's.sqlite')
  const a = createDb({ file, seed: () => ({ items: [] }), pollMs: 0 })
  const b = createDb({ file, seed: () => ({ items: ['wrong'] }), pollMs: 0 })
  a.mutate((s) => s.items.push('a1'))
  b.mutate((s) => s.items.push('b1'))
  assert.deepEqual(a.read().items, ['a1', 'b1'])
  assert.equal(a.read().version, 2)
  a.close()
  b.close()
  done()
})

test('failed mutations roll back', () => {
  const { dir, done } = tmp()
  const db = createDb({ file: join(dir, 's.sqlite'), seed: () => ({ n: 1 }), pollMs: 0 })
  assert.throws(() =>
    db.mutate((s) => {
      s.n = 99
      throw new Error('nope')
    }),
  )
  assert.equal(db.read().n, 1)
  db.close()
  done()
})

test('sessions survive a reopen and store only hashes', () => {
  const { dir, done } = tmp()
  const file = join(dir, 's.sqlite')
  const first = createDb({ file, seed: () => ({}), pollMs: 0 })
  const token = first.sessions.create({ id: 'u1' })
  first.close()
  const second = createDb({ file, seed: () => ({}), pollMs: 0 })
  assert.equal(second.sessions.get(token).userId, 'u1')
  second.sessions.destroyUser('u1')
  assert.equal(second.sessions.get(token), null)
  second.close()
  done()
})

test('audit log, backups and JSON migration', () => {
  const { dir, done } = tmp()
  const legacy = join(dir, 'old.json')
  writeFileSync(legacy, JSON.stringify({ version: 7, hello: 'world' }))
  const db = createDb({ file: join(dir, 's.sqlite'), seed: () => ({ hello: 'seed' }), legacyJsonFile: legacy, backupDir: join(dir, 'bk'), pollMs: 0 })
  assert.equal(db.read().hello, 'world')
  assert.equal(existsSync(`${legacy}.migrated`), true)
  db.audit({ actor: 'ops@x', action: 'POST /api/admin/reset', outcome: 'ok', details: { a: 1 } })
  assert.equal(db.auditList()[0].details.a, 1)
  db.backup({ keep: 2 })
  db.backup({ keep: 2 })
  db.backup({ keep: 2 })
  assert.equal(db.backups().length, 2)
  db.close()
  done()
})
