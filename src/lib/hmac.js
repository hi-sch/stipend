export async function signBody(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function verifyHmac(secret, body, header) {
  const got = String(header || '').replace(/^sha256=/i, '').toLowerCase()
  const exp = await signBody(secret, body)
  if (got.length !== exp.length) return false
  let diff = 0
  for (let i = 0; i < exp.length; i++) diff |= got.charCodeAt(i) ^ exp.charCodeAt(i)
  return diff === 0
}
