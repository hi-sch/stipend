import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLogger } from './log.js'

test('writes JSON lines with level filtering and child fields', () => {
  const lines = []
  const stream = { write: (s) => lines.push(s) }
  const log = createLogger({ level: 'info', stream }).child({ reqId: 'r1' })
  log.debug('hidden')
  log.info('request', { status: 200 })
  log.error('boom', { err: new Error('bad') })
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  assert.equal(first.msg, 'request')
  assert.equal(first.reqId, 'r1')
  assert.equal(JSON.parse(lines[1]).err.message, 'bad')
})
