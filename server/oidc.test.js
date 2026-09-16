import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOidc, OIDC_COOKIE } from './oidc.js'

const ISSUER = 'https://idp.example.test'
const REDIRECT = 'https://stipend.example.test/api/auth/oidc/callback'

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
}

const env = (extra = {}) => ({
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: 'stipend',
  OIDC_CLIENT_SECRET: 'secret-value',
  ...extra,
})

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })

/**
 * A provider that answers discovery, token exchange and userinfo. `overrides` replaces any
 * one of them, and every request is recorded so the test can assert what was sent.
 */
function fakeProvider({ userinfo = {}, tokens = { access_token: 'at' }, overrides = {} } = {}) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    const href = String(url)
    calls.push({ url: href, options })

    if (href.includes('.well-known')) return overrides.discovery ?? json(DISCOVERY)
    if (href === DISCOVERY.token_endpoint) return overrides.token ?? json(tokens)
    if (href === DISCOVERY.userinfo_endpoint) return overrides.userinfo ?? json({ sub: 'u-1', email: 'ops@example.test', name: 'Mira Kessler', ...userinfo })
    throw new Error(`unexpected fetch: ${href}`)
  }
  return { fetchImpl, calls }
}

/** Walk a full handshake and hand back what the callback produced. */
async function signIn({ oidc, query, cookie } = {}) {
  const started = await oidc.begin({ redirectUri: REDIRECT })
  const url = new URL(started.url)
  return oidc.complete({
    query: new URLSearchParams({ code: 'the-code', state: url.searchParams.get('state'), ...query }),
    cookieValue: cookie ?? started.cookie,
    redirectUri: REDIRECT,
  })
}

test('sso is off until issuer, client id and secret are all set', () => {
  assert.equal(createOidc({ env: {} }).enabled, false)
  assert.equal(createOidc({ env: { OIDC_ISSUER: ISSUER } }).enabled, false)
  assert.equal(createOidc({ env: { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: 'stipend' } }).enabled, false)
  assert.equal(createOidc({ env: env() }).enabled, true)
})

test('beginning a login without configuration is a 503, not a crash', async () => {
  const oidc = createOidc({ env: {} })
  await assert.rejects(() => oidc.begin({ redirectUri: REDIRECT }), (err) => err.status === 503)
})

test('the authorization url carries pkce, state and nonce', async () => {
  const { fetchImpl } = fakeProvider()
  const oidc = createOidc({ env: env(), fetchImpl })

  const { url, cookie } = await oidc.begin({ redirectUri: REDIRECT })
  const params = new URL(url).searchParams

  assert.equal(new URL(url).origin + new URL(url).pathname, DISCOVERY.authorization_endpoint)
  assert.equal(params.get('response_type'), 'code')
  assert.equal(params.get('client_id'), 'stipend')
  assert.equal(params.get('redirect_uri'), REDIRECT)
  assert.equal(params.get('code_challenge_method'), 'S256')
  assert.ok(params.get('code_challenge'))
  assert.ok(params.get('state'))
  assert.ok(params.get('nonce'))
  assert.match(params.get('scope'), /openid/)

  // The verifier travels in the signed cookie, never in the URL.
  assert.ok(!url.includes('code_verifier'))
  assert.ok(cookie.includes('.'), 'the handshake cookie is signed')
})

test('a successful sign-in returns the mapped operator', async () => {
  const { fetchImpl, calls } = fakeProvider()
  const oidc = createOidc({ env: env(), fetchImpl })

  const user = await signIn({ oidc })

  assert.equal(user.subject, 'u-1')
  assert.equal(user.email, 'ops@example.test')
  assert.equal(user.name, 'Mira Kessler')
  assert.equal(user.issuer, ISSUER)

  // The code was exchanged with the verifier and the client secret.
  const exchange = calls.find((c) => c.url === DISCOVERY.token_endpoint)
  const sent = new URLSearchParams(exchange.options.body)
  assert.equal(sent.get('grant_type'), 'authorization_code')
  assert.equal(sent.get('code'), 'the-code')
  assert.equal(sent.get('client_secret'), 'secret-value')
  assert.ok(sent.get('code_verifier'))

  // Identity came from userinfo, fetched with the access token.
  const profile = calls.find((c) => c.url === DISCOVERY.userinfo_endpoint)
  assert.equal(profile.options.headers.authorization, 'Bearer at')
})

test('a mismatched state is refused', async () => {
  const { fetchImpl } = fakeProvider()
  const oidc = createOidc({ env: env(), fetchImpl })

  await assert.rejects(
    () => signIn({ oidc, query: { state: 'not-the-state-we-issued' } }),
    (err) => err.status === 403 && /state does not match/.test(err.message),
  )
})

test('a tampered handshake cookie is refused', async () => {
  const { fetchImpl } = fakeProvider()
  const oidc = createOidc({ env: env(), fetchImpl })

  const started = await oidc.begin({ redirectUri: REDIRECT })
  const [payload] = started.cookie.split('.')
  const forged = `${payload}.${'A'.repeat(43)}`

  await assert.rejects(
    () =>
      oidc.complete({
        query: new URLSearchParams({ code: 'the-code', state: new URL(started.url).searchParams.get('state') }),
        cookieValue: forged,
        redirectUri: REDIRECT,
      }),
    /not valid/,
  )
})

test('a cookie signed with another secret is refused', async () => {
  const { fetchImpl } = fakeProvider()
  const mine = createOidc({ env: env(), fetchImpl })
  const theirs = createOidc({ env: env({ OIDC_CLIENT_SECRET: 'a-different-secret' }), fetchImpl })

  const started = await theirs.begin({ redirectUri: REDIRECT })

  await assert.rejects(
    () =>
      mine.complete({
        query: new URLSearchParams({ code: 'the-code', state: new URL(started.url).searchParams.get('state') }),
        cookieValue: started.cookie,
        redirectUri: REDIRECT,
      }),
    /not valid/,
  )
})

test('a missing handshake cookie is refused', async () => {
  const { fetchImpl } = fakeProvider()
  const oidc = createOidc({ env: env(), fetchImpl })
  await assert.rejects(() => signIn({ oidc, cookie: '' }), /missing/)
})

test('an error from the provider is reported, not swallowed', async () => {
  const { fetchImpl } = fakeProvider()
  const oidc = createOidc({ env: env(), fetchImpl })

  await assert.rejects(
    () => signIn({ oidc, query: { error: 'access_denied', error_description: 'User cancelled' } }),
    (err) => err.status === 403 && /User cancelled/.test(err.message),
  )
})

test('group membership decides whether the account is an operator', async () => {
  const allowed = fakeProvider({ userinfo: { groups: ['stipend-operators', 'everyone'] } })
  const granted = createOidc({ env: env({ OIDC_ADMIN_GROUP: 'stipend-operators' }), fetchImpl: allowed.fetchImpl })
  const user = await signIn({ oidc: granted })
  assert.deepEqual(user.groups, ['stipend-operators', 'everyone'])

  const denied = fakeProvider({ userinfo: { groups: ['everyone'] } })
  const refused = createOidc({ env: env({ OIDC_ADMIN_GROUP: 'stipend-operators' }), fetchImpl: denied.fetchImpl })
  await assert.rejects(() => signIn({ oidc: refused }), (err) => err.status === 403 && /operator group/.test(err.message))
})

test('groups are accepted as an array, a space list or a comma list', async () => {
  for (const groups of [['ops'], 'ops other', 'ops,other']) {
    const { fetchImpl } = fakeProvider({ userinfo: { groups } })
    const oidc = createOidc({ env: env({ OIDC_ADMIN_GROUP: 'ops' }), fetchImpl })
    const user = await signIn({ oidc })
    assert.ok(user.groups.includes('ops'))
  }
})

test('without a configured group every authenticated user is an operator', async () => {
  const { fetchImpl } = fakeProvider({ userinfo: { groups: [] } })
  const oidc = createOidc({ env: env(), fetchImpl })
  const user = await signIn({ oidc })
  assert.equal(user.email, 'ops@example.test')
})

test('a discovery document for another issuer is refused', async () => {
  const { fetchImpl } = fakeProvider({
    overrides: { discovery: { ok: true, status: 200, json: async () => ({ ...DISCOVERY, issuer: 'https://evil.example.test' }) } },
  })
  const oidc = createOidc({ env: env(), fetchImpl })
  await assert.rejects(() => oidc.begin({ redirectUri: REDIRECT }), /does not match OIDC_ISSUER/)
})

test('a provider missing an endpoint is refused', async () => {
  const { fetchImpl } = fakeProvider({
    overrides: { discovery: { ok: true, status: 200, json: async () => ({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize` }) } },
  })
  const oidc = createOidc({ env: env(), fetchImpl })
  await assert.rejects(() => oidc.begin({ redirectUri: REDIRECT }), /missing token_endpoint/)
})

test('a failed token exchange is a bad gateway, not a sign-in', async () => {
  const { fetchImpl } = fakeProvider({ overrides: { token: json({ error: 'invalid_grant' }, 400) } })
  const oidc = createOidc({ env: env(), fetchImpl })
  await assert.rejects(() => signIn({ oidc }), (err) => err.status === 502)
})

test('a profile without an email is refused', async () => {
  const { fetchImpl } = fakeProvider({ userinfo: { email: undefined, preferred_username: undefined } })
  const oidc = createOidc({ env: env(), fetchImpl })
  await assert.rejects(() => signIn({ oidc }), (err) => err.status === 403 && /email/.test(err.message))
})

test('the return path cannot be pointed at another site', async () => {
  const { fetchImpl } = fakeProvider()
  const oidc = createOidc({ env: env(), fetchImpl })

  for (const [asked, expected] of [
    ['/admin/settings', '/admin/settings'],
    ['https://evil.example.test', '/'],
    ['//evil.example.test', '/'],
    [null, '/'],
  ]) {
    const started = await oidc.begin({ redirectUri: REDIRECT, returnTo: asked })
    const user = await oidc.complete({
      query: new URLSearchParams({ code: 'the-code', state: new URL(started.url).searchParams.get('state') }),
      cookieValue: started.cookie,
      redirectUri: REDIRECT,
    })
    assert.equal(user.returnTo, expected)
  }
})

test('describe reports configuration without the secret', () => {
  const described = createOidc({ env: env({ OIDC_ADMIN_GROUP: 'ops' }) }).describe()
  assert.equal(described.enabled, true)
  assert.equal(described.issuer, ISSUER)
  assert.equal(described.adminGroup, 'ops')
  assert.equal(JSON.stringify(described).includes('secret-value'), false)
})

test('the cookie name is stable', () => {
  assert.equal(OIDC_COOKIE, 'stipend_oidc')
})
