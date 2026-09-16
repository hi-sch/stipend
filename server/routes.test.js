import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The console and the API have to agree about which endpoints exist.
 *
 * Rewriting the server dropped several routes the admin console still called. Nothing
 * failed until somebody opened the page and got a 404 rendered as "Not found", because no
 * test knew the frontend and the route table were meant to match. This is that test.
 */

// Every file that registers routes. A module missing from here is invisible to these
// checks, which is how moving routes into a new file looks exactly like deleting them.
const MODULES = ['server/app.js', 'server/responders.js', 'server/ledgerRoutes.js', 'server/cardholderRoutes.js']

/** Routes are registered as route(METHOD, path, …), sometimes spread over several lines. */
function registeredRoutes() {
  const routes = []
  for (const file of MODULES) {
    const src = readFileSync(join(root, file), 'utf8')
    for (const m of src.matchAll(/\broute\(\s*'([A-Z]+)'\s*,\s*'([^']+)'/gs)) {
      routes.push({ method: m[1], path: m[2], parts: m[2].split('/').filter(Boolean) })
    }
  }
  return routes
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) sourceFiles(path, out)
    else if (/\.(jsx?|mjs)$/.test(path)) out.push(path)
  }
  return out
}

/**
 * Every /api/ path the frontend asks for. A `${…}` in a template literal is a value the
 * page fills in, so it matches any single segment.
 */
function frontendCalls() {
  const calls = new Map()
  const record = (method, raw, file) => {
    // Not ours: absolute URLs point at third-party services.
    if (/^https?:\/\//.test(raw)) return
    // Collapse interpolations before stripping the query string. An interpolation can
    // contain a ternary — `/api/hooks/${kind === 'recall' ? 'recalls' : 'credits'}` — and
    // splitting on that ? first would cut the path in half.
    //
    // A nested template literal ends the capture early, leaving an interpolation with no
    // closing brace; everything from there is unknowable, so it becomes a trailing
    // wildcard and only the static part in front of it is checked.
    const path = raw
      .replace(/\$\{[^}]*\}/g, '*')
      .replace(/\$\{.*$/, '*')
      .split('?')[0]
    calls.set(`${method} ${path}`, { method, path, file: file.replace(`${root}/`, '') })
  }

  for (const file of sourceFiles(join(root, 'src'))) {
    const src = readFileSync(file, 'utf8')
    for (const [re, method] of PATTERNS) {
      for (const m of src.matchAll(re)) record(method ?? METHODS[m[1]], method ? m[1] : m[2], file)
    }
  }
  return [...calls.values()]
}

const METHODS = { get: 'GET', post: 'POST', patch: 'PATCH', del: 'DELETE', put: 'PUT' }

/**
 * A backtick literal can contain quotes inside an interpolation:
 *   get(`/api/hooks/${kind === 'recall' ? 'recalls' : 'credits'}/${id}`)
 * so backtick strings are matched on backticks alone. Matching on any quote cuts the path
 * short and reports a call the server does serve as missing — a test that cries wolf is
 * worse than no test.
 */
const PATTERNS = [
  [/\b(get|post|patch|del|put)\(\s*`([^`]*\/api\/[^`]*)`/g, null],
  [/\b(get|post|patch|del|put)\(\s*'([^']*\/api\/[^']*)'/g, null],
  [/\b(get|post|patch|del|put)\(\s*"([^"]*\/api\/[^"]*)"/g, null],
  // A bare fetch() carries its method in an options object on a later line, so the verb is
  // not knowable from the call site alone. These match a route of any method: guessing GET
  // reported a POST call as unserved.
  [/(?:EventSource|fetch)\(\s*`([^`]*\/api\/[^`]*)`/g, 'ANY'],
  [/(?:EventSource|fetch)\(\s*'([^']*\/api\/[^']*)'/g, 'ANY'],
]

/**
 * Whether a call the console makes reaches a route.
 *
 * A path with no interpolation is compared segment by segment, with :params matching
 * anything. A path that interpolates is only compared up to its first interpolation:
 * these are query-string builders like
 *   `/api/admin/events${type ? `?event_type=${type}` : ''}`
 * and matching the rest would mean parsing JavaScript, which is not what a test should do.
 * The static prefix is enough for the failure this guards against — a route that was
 * deleted while the console kept calling it.
 */
const resolves = (call, routes) => {
  const parts = call.path.split('/').filter(Boolean)
  const firstDynamic = parts.findIndex((p) => p.includes('*'))
  // Check up to and including the segment the interpolation starts in: `events*` still
  // tells us the route must begin with `events`.
  const fixed = firstDynamic === -1 ? parts : parts.slice(0, firstDynamic + 1)

  return routes.some((r) => {
    if (call.method !== 'ANY' && r.method !== call.method) return false
    if (firstDynamic === -1 && r.parts.length !== parts.length) return false
    if (r.parts.length < fixed.length) return false
    return fixed.every((p, i) => {
      if (r.parts[i].startsWith(':')) return true
      if (p.endsWith('*')) return r.parts[i].startsWith(p.slice(0, -1))
      return r.parts[i] === p
    })
  })
}

test('every API path the console calls is a route the server registers', () => {
  const routes = registeredRoutes()
  const calls = frontendCalls()

  assert.ok(routes.length > 90, `expected the full route table, found ${routes.length}`)
  assert.ok(calls.length > 40, `expected the console to call many endpoints, found ${calls.length}`)

  const missing = calls.filter((c) => !resolves(c, routes))
  assert.deepEqual(
    missing.map((c) => `${c.method} ${c.path} (${c.file})`),
    [],
    'the console calls endpoints the server does not serve',
  )
})

test('routes are registered once', () => {
  const seen = new Set()
  const duplicates = []
  for (const r of registeredRoutes()) {
    const key = `${r.method} ${r.path}`
    if (seen.has(key)) duplicates.push(key)
    seen.add(key)
  }
  // A second registration is unreachable: the dispatcher takes the first match.
  assert.deepEqual(duplicates, [], 'these routes are registered more than once')
})

test('health, the hooks and the responders stay public', () => {
  const src = readFileSync(join(root, 'server/app.js'), 'utf8')
  for (const path of ['/api/health', '/api/health/live', '/api/health/ready', '/api/asa', '/api/webhooks/lithic']) {
    const pattern = new RegExp(`route\\(\\s*'[A-Z]+'\\s*,\\s*'${path.replace(/\//g, '\\/')}'\\s*,\\s*'public'`, 's')
    assert.ok(pattern.test(src), `${path} must stay public: Lithic and the probes cannot sign in`)
  }
})

/**
 * A rate limit is keyed on the registered path. A typo in that table does not fail — it
 * silently leaves the endpoint unlimited, which is exactly the kind of thing nobody
 * notices until it is being used.
 */
test('every rate-limited path is a route that exists, and is public', () => {
  const src = readFileSync(join(root, 'server/app.js'), 'utf8')

  const block = src.match(/export const PUBLIC_RATE_LIMITS = \{([\s\S]*?)\n\}/)
  assert.ok(block, 'PUBLIC_RATE_LIMITS is no longer declared the way this test looks for it')
  const limited = [...block[1].matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
  assert.ok(limited.length >= 6, `expected the rate limit table to have entries, found ${limited.length}`)

  const routes = registeredRoutes()
  const publics = new Set()
  for (const file of MODULES) {
    for (const m of readFileSync(join(root, file), 'utf8').matchAll(/\broute\(\s*'[A-Z]+'\s*,\s*'([^']+)'\s*,\s*'public'/gs)) {
      publics.add(m[1])
    }
  }

  for (const path of limited) {
    assert.ok(routes.some((r) => r.path === path), `${path} has a rate limit but is not a registered route`)
    assert.ok(publics.has(path), `${path} has a public rate limit but is not registered as public`)
  }
})
