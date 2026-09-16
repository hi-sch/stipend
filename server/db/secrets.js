import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * Encryption for the secrets Stipend has to keep: connection HMAC secrets, and the ASA,
 * webhook, 3DS and tokenization secrets Lithic issues.
 *
 * These were stored in clear, which means a database dump — a backup, a replica, a stray
 * pg_dump — is a full key compromise. They are now sealed with AES-256-GCM in the
 * application rather than with pgcrypto, so the key never appears in a SQL statement, a
 * query log, or a slow-query report.
 *
 * Two deliberate accommodations:
 *
 *   - Without STIPEND_SECRET_KEY the values pass through unchanged. A program that has
 *     never configured a key still runs, and the admin console reports encryption as off
 *     rather than the server refusing to start. Turning the key on seals new writes.
 *   - A value that is not sealed is returned as it is. Rows written before a key existed
 *     keep working, and are sealed the next time they are written.
 */

const PREFIX = 'enc.v1.'

/**
 * The key is derived rather than used raw, so STIPEND_SECRET_KEY can be any passphrase of
 * reasonable length instead of exactly 32 bytes of base64 that somebody has to generate
 * correctly under pressure.
 */
function deriveKey(secret) {
  return scryptSync(String(secret), 'stipend.secret.v1', 32)
}

let shared = null

/**
 * Give the program its box. Called by createApp before anything reads a secret.
 *
 * The env has to be handed in rather than read from process.env: standalone.js merges the
 * .env file over the process environment and passes the result to createApp, so a key set
 * in .env — which is where it is documented — would otherwise be invisible here, and
 * secrets would be written in clear while the console reported encryption as on.
 */
export function configureSecretBox(env, log) {
  shared = createSecretBox({ env, log })
  return shared
}

/**
 * The program's box.
 *
 * Sealing happens where values enter and leave the database — connectionRow, and the
 * program settings blob — rather than at each caller. A write site nobody remembered
 * stores a secret in clear; a read site nobody remembered breaks signature verification on
 * a live agency hook. Two choke points can be reasoned about; eight cannot.
 */
export function secretBox() {
  if (!shared) shared = createSecretBox({ env: process.env, log: console })
  return shared
}

export function createSecretBox({ env = {}, log } = {}) {
  const passphrase = env.STIPEND_SECRET_KEY || ''
  const configured = passphrase.length >= 16
  const key = configured ? deriveKey(passphrase) : null

  if (passphrase && !configured) {
    log?.warn?.('STIPEND_SECRET_KEY is too short to use; secrets are being stored in clear', { minimum: 16 })
  }

  const sealed = (value) => typeof value === 'string' && value.startsWith(PREFIX)

  return {
    configured,

    /** Seal a value for storage. Without a key this is the identity function. */
    seal(value) {
      if (!configured || value === null || value === undefined || value === '') return value
      if (sealed(value)) return value

      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()

      return PREFIX + [iv, tag, body].map((b) => b.toString('base64url')).join('.')
    },

    /**
     * Open a stored value. Anything not sealed is returned unchanged, which is what makes
     * turning the key on a non-event for existing rows.
     */
    open(value) {
      if (!sealed(value)) return value
      if (!configured) throw new Error('This value is encrypted but STIPEND_SECRET_KEY is not set.')

      const [ivPart, tagPart, bodyPart] = value.slice(PREFIX.length).split('.')
      if (!ivPart || !tagPart || !bodyPart) throw new Error('Encrypted value is malformed.')

      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64url'))
      decipher.setAuthTag(Buffer.from(tagPart, 'base64url'))
      // GCM verifies the tag on final(): a tampered value throws rather than decrypting to
      // something plausible.
      return Buffer.concat([decipher.update(Buffer.from(bodyPart, 'base64url')), decipher.final()]).toString('utf8')
    },

    /** Whether a stored value is already sealed, for reporting and for migrations. */
    isSealed: sealed,

    /** Constant-time comparison, for secrets that are checked rather than decrypted. */
    matches(a, b) {
      const x = Buffer.from(String(a ?? ''))
      const y = Buffer.from(String(b ?? ''))
      return x.length === y.length && timingSafeEqual(x, y)
    },
  }
}
