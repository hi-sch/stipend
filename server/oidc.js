import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Operator single sign-on over OpenID Connect.
 *
 * Cardholders keep local passwords. Operators federate, so joiners and leavers are handled
 * where the rest of the organisation handles them rather than in Stipend's user table.
 *
 * Authorization code flow with PKCE. Identity is read from the userinfo endpoint rather
 * than from the ID token, which means Stipend only ever trusts a response it fetched
 * itself over TLS with client authentication. The ID token is accepted the same way the
 * spec allows for the code flow (OIDC core 3.1.3.7): received directly from the token
 * endpoint, so its signature is not separately verified. The tradeoff is deliberate — the
 * alternative is hand-rolled JWT and JWKS verification, which is the last place a payments
 * codebase should carry its own crypto.
 *
 * The CSRF state and the PKCE verifier live in a short-lived signed cookie, not in server
 * memory, because with more than one replica the pod that starts a login is usually not
 * the pod that finishes it.
 */

export const OIDC_COOKIE = 'stipend_oidc'

// A login has to be completed in a reasonable window; after that the handshake is stale.
const HANDSHAKE_TTL_MS = 10 * 60 * 1000

const base64url = (buffer) => buffer.toString('base64url')

/** Structured error the route layer can turn into a status code. */
class OidcError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

export { OidcError }

export function createOidc({ env = {}, log, fetchImpl = globalThis.fetch } = {}) {
  const issuer = (env.OIDC_ISSUER || '').replace(/\/+$/, '')
  const clientId = env.OIDC_CLIENT_ID || ''
  const clientSecret = env.OIDC_CLIENT_SECRET || ''
  const enabled = Boolean(issuer && clientId && clientSecret)

  const groupsClaim = env.OIDC_GROUPS_CLAIM || 'groups'
  const adminGroup = env.OIDC_ADMIN_GROUP || ''
  const scopes = ['openid', 'email', 'profile', ...String(env.OIDC_SCOPES || '').split(/[\s,]+/).filter(Boolean)]

  let discovered = null

  /**
   * The provider's endpoints, fetched once. A provider that cannot be reached is a
   * configuration problem an operator needs to see, not something to paper over.
   */
  async function discover() {
    if (!enabled) throw new OidcError('Single sign-on is not configured.', 503)
    if (discovered) return discovered

    const url = `${issuer}/.well-known/openid-configuration`
    const response = await fetchImpl(url, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new OidcError(`Identity provider discovery failed (${response.status}).`, 502)

    const doc = await response.json()
    for (const key of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint']) {
      if (!doc[key]) throw new OidcError(`Identity provider is missing ${key}.`, 502)
    }
    // The issuer the provider claims must be the one we were configured with, or the
    // discovery document is not describing the provider we think it is.
    if (doc.issuer && doc.issuer.replace(/\/+$/, '') !== issuer) {
      throw new OidcError('Identity provider issuer does not match OIDC_ISSUER.', 502)
    }

    discovered = doc
    log?.info?.('oidc discovery complete', { issuer })
    return doc
  }

  // The handshake cookie is signed with the client secret, which both replicas already
  // share and which never leaves the server.
  function sign(payload) {
    return createHmac('sha256', clientSecret).update(payload).digest('base64url')
  }

  function sealHandshake(handshake) {
    const payload = base64url(Buffer.from(JSON.stringify(handshake)))
    return `${payload}.${sign(payload)}`
  }

  function openHandshake(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) throw new OidcError('Sign-in session is missing. Start again.')
    const [payload, mac] = cookieValue.split('.')

    const expected = Buffer.from(sign(payload))
    const actual = Buffer.from(mac || '')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new OidcError('Sign-in session is not valid. Start again.')
    }

    const handshake = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (Date.now() > handshake.expires) throw new OidcError('Sign-in took too long. Start again.')
    return handshake
  }

  /**
   * Begin a login. Returns the provider URL to send the browser to and the cookie value
   * that has to come back with the callback.
   */
  async function begin({ redirectUri, returnTo = '/' } = {}) {
    const doc = await discover()

    const state = base64url(randomBytes(24))
    const nonce = base64url(randomBytes(24))
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(createHash('sha256').update(verifier).digest())

    const url = new URL(doc.authorization_endpoint)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('scope', scopes.join(' '))
    url.searchParams.set('state', state)
    url.searchParams.set('nonce', nonce)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')

    return {
      url: url.toString(),
      cookie: sealHandshake({
        state,
        nonce,
        verifier,
        // Only a path, never an absolute URL: an open redirect here would let a phishing
        // page borrow the provider's sign-in flow.
        returnTo: typeof returnTo === 'string' && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/',
        expires: Date.now() + HANDSHAKE_TTL_MS,
      }),
    }
  }

  /**
   * Finish a login. Verifies the state, exchanges the code, reads identity from userinfo
   * and maps it onto Stipend's notion of an operator.
   */
  async function complete({ query, cookieValue, redirectUri } = {}) {
    const doc = await discover()
    const handshake = openHandshake(cookieValue)

    const error = query?.get?.('error') ?? query?.error
    if (error) {
      const description = query?.get?.('error_description') ?? query?.error_description
      throw new OidcError(`Identity provider refused the sign-in: ${description || error}`, 403)
    }

    const code = query?.get?.('code') ?? query?.code
    const state = query?.get?.('state') ?? query?.state
    if (!code) throw new OidcError('Identity provider did not return a code.')

    const expected = Buffer.from(handshake.state)
    const actual = Buffer.from(String(state || ''))
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new OidcError('Sign-in state does not match. Start again.', 403)
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
      code_verifier: handshake.verifier,
    })

    const tokenResponse = await fetchImpl(doc.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    })
    if (!tokenResponse.ok) throw new OidcError(`Token exchange failed (${tokenResponse.status}).`, 502)

    const tokens = await tokenResponse.json()
    if (!tokens.access_token) throw new OidcError('Identity provider returned no access token.', 502)

    const userResponse = await fetchImpl(doc.userinfo_endpoint, {
      headers: { authorization: `Bearer ${tokens.access_token}`, accept: 'application/json' },
    })
    if (!userResponse.ok) throw new OidcError(`Could not read the user profile (${userResponse.status}).`, 502)

    const claims = await userResponse.json()
    if (!claims.sub) throw new OidcError('Identity provider returned no subject.', 502)

    const email = claims.email || claims.preferred_username || ''
    if (!email) throw new OidcError('Identity provider returned no email address.', 403)

    const groups = normaliseGroups(claims[groupsClaim])
    // Without a configured group every authenticated user is an operator. That is a real
    // decision, so it is stated in .env.example and surfaced in the admin settings table.
    const isAdmin = adminGroup ? groups.includes(adminGroup) : true
    if (!isAdmin) throw new OidcError('This account is not a member of the operator group.', 403)

    return {
      issuer,
      subject: String(claims.sub),
      email: String(email).toLowerCase(),
      name: claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email,
      groups,
      returnTo: handshake.returnTo,
    }
  }

  return {
    enabled,
    issuer,
    clientId,
    adminGroup,
    discover,
    begin,
    complete,
    // Exposed for the admin settings table, which reports configuration without secrets.
    describe: () => ({ enabled, issuer, clientId, groupsClaim, adminGroup: adminGroup || null, scopes }),
  }
}

/** Providers send groups as an array, a space list or a comma list. Accept all three. */
function normaliseGroups(value) {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean)
  return []
}
