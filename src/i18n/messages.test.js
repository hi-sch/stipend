import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LOCALES, messages } from './messages.js'

const src = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The interface and its translations have to agree about which keys exist.
 *
 * t() falls back to English and then to the key itself, so a key that does not exist renders
 * as `txn.events` — or worse, resolves to something that was meant for somewhere else. That
 * is not an error anyone sees until it is on a page in front of a cardholder. These are the
 * two things that can be checked from here.
 */

function keyPaths(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([k, v]) => keyPaths(v, prefix ? `${prefix}.${k}` : k))
}

function lookup(dict, path) {
  return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), dict)
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'i18n' || entry === 'node_modules') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.jsx?$/.test(path) && !path.endsWith('.test.js') && !path.endsWith('.test.jsx')) out.push(path)
  }
  return out
}

test('every key the interface asks for exists in English', () => {
  // t('a.b') with a literal key. Anything built at runtime is out of reach here and is not
  // what this is guarding against: renaming a key and missing a call site is.
  const asked = new Map()
  for (const file of sourceFiles(src)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/\bt\('([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g)) {
      if (!asked.has(m[1])) asked.set(m[1], file.replace(`${src}/`, ''))
    }
  }

  assert.ok(asked.size > 100, `expected the interface to use many keys, found ${asked.size}`)

  const missing = [...asked].filter(([key]) => lookup(messages.en, key) === undefined)
  assert.deepEqual(
    missing.map(([key, file]) => `${key} (${file})`),
    [],
    'these keys are used but not defined in English, so they render as their own path',
  )
})

test('no language defines a key English does not have', () => {
  // English is the fallback, so a key only another language has can never be reached through
  // it. It is a translation of something that no longer exists, or a typo in the path.
  const english = new Set(keyPaths(messages.en))

  for (const lang of Object.keys(LOCALES)) {
    if (lang === 'en') continue
    const orphans = keyPaths(messages[lang]).filter((path) => !english.has(path))
    assert.deepEqual(orphans, [], `${lang} defines keys English does not: ${orphans.join(', ')}`)
  }
})

test('every language Stipend offers has messages behind it', () => {
  for (const lang of Object.keys(LOCALES)) {
    assert.ok(messages[lang], `${lang} is offered in the language picker but has no messages`)
    assert.ok(keyPaths(messages[lang]).length > 50, `${lang} has almost nothing translated`)
  }
})
