// Program settings an operator can change at runtime. Stored in state.settings.app; each value
// falls back to its environment variable, then to a default. Secrets never live here: API keys,
// SMTP credentials and passwords stay in .env and are only reported as set or missing.

export const SETTINGS_DEFAULTS = {
  programName: 'Stipend',
  organisation: '',
  supportEmail: '',
  supportPhone: '',
  publicUrl: '',
  defaultDailyLimitCents: 15000,
  cardSpendLimitCents: 500000,
  cardSpendLimitDuration: 'MONTHLY',
  cardProductId: '',
  mailFrom: 'Stipend <no-reply@stipend.local>',
  backupKeep: 7,
}

const ENV_FALLBACK = {
  publicUrl: 'PUBLIC_URL',
  cardProductId: 'LITHIC_PRODUCT_ID',
  mailFrom: 'MAIL_FROM',
  backupKeep: 'STIPEND_BACKUP_KEEP',
}

export const SPEND_LIMIT_DURATIONS = ['TRANSACTION', 'MONTHLY', 'ANNUALLY', 'FOREVER']

/** Server configuration an operator needs to know about; values of secrets are never reported. */
export const SERVER_CONFIG = [
  { key: 'LITHIC_API_KEY', group: 'lithic', secret: true, required: true },
  { key: 'LITHIC_ENV', group: 'lithic' },
  { key: 'LITHIC_WEBHOOK_SECRET', group: 'lithic', secret: true },
  { key: 'LITHIC_ASA_SECRET', group: 'lithic', secret: true },
  { key: 'LITHIC_3DS_SECRET', group: 'lithic', secret: true },
  { key: 'LITHIC_TOKENIZATION_SECRET', group: 'lithic', secret: true },
  { key: 'LITHIC_PRODUCT_ID', group: 'lithic' },
  { key: 'LITHIC_GOOGLE_INTEGRATOR_ID', group: 'lithic' },
  { key: 'LITHIC_APPLE_PARTNER_ID', group: 'lithic' },
  { key: 'SMTP_URL', group: 'email', secret: true },
  { key: 'MAIL_FROM', group: 'email' },
  { key: 'PUBLIC_URL', group: 'server' },
  { key: 'HOST', group: 'server' },
  { key: 'PORT', group: 'server' },
  { key: 'STIPEND_SECURE_COOKIES', group: 'server' },
  { key: 'STIPEND_DATA_FILE', group: 'storage' },
  { key: 'STIPEND_BACKUP_DIR', group: 'storage' },
  { key: 'STIPEND_BACKUP_KEEP', group: 'storage' },
  { key: 'LOG_FORMAT', group: 'server' },
  { key: 'LOG_LEVEL', group: 'server' },
  { key: 'STIPEND_ADMIN_PASSWORD', group: 'accounts', secret: true },
  { key: 'STIPEND_CARDHOLDER_PASSWORD', group: 'accounts', secret: true },
]

const present = (value) => value !== undefined && value !== null && value !== ''

function envValue(key, env) {
  const name = ENV_FALLBACK[key]
  if (!name || !present(env[name])) return undefined
  return key === 'backupKeep' ? Number(env[name]) : env[name]
}

export function appSettings(state, env = {}) {
  const saved = state?.settings?.app || {}
  const out = {}
  for (const key of Object.keys(SETTINGS_DEFAULTS)) {
    const fromEnv = envValue(key, env)
    out[key] = present(saved[key]) ? saved[key] : fromEnv !== undefined ? fromEnv : SETTINGS_DEFAULTS[key]
  }
  if (!present(saved.organisation) && state?.operator?.org) out.organisation = state.operator.org
  return out
}

/** Where each effective value comes from: 'saved', 'env' or 'default'. */
export function settingSources(state, env = {}) {
  const saved = state?.settings?.app || {}
  return Object.fromEntries(
    Object.keys(SETTINGS_DEFAULTS).map((key) => [key, present(saved[key]) ? 'saved' : envValue(key, env) !== undefined ? 'env' : 'default']),
  )
}

export function serverConfig(env = {}) {
  return SERVER_CONFIG.map(({ key, group, secret = false, required = false }) => ({
    key,
    group,
    secret,
    required,
    set: present(env[key]),
    value: secret || !present(env[key]) ? null : String(env[key]),
  }))
}

function invalid(message) {
  return Object.assign(new Error(message), { status: 400 })
}

function text(value, max, label) {
  const clean = String(value ?? '').trim()
  if (clean.length > max) throw invalid(`${label} can be at most ${max} characters.`)
  return clean
}

function cents(value, { min, max, label }) {
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${label} must be between ${min / 100} and ${max / 100} EUR.`)
  return n
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

/** Validates a partial update. `null` or '' clears a saved value so the env or default applies again. */
export function validateSettings(patch = {}) {
  const out = {}
  const unknown = Object.keys(patch).filter((key) => !(key in SETTINGS_DEFAULTS))
  if (unknown.length) throw invalid(`Unknown setting: ${unknown.join(', ')}`)
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === null || raw === '') {
      if (key === 'programName') throw invalid('Program name is required.')
      out[key] = null
      continue
    }
    switch (key) {
      case 'programName':
        out[key] = text(raw, 60, 'Program name')
        if (!out[key]) throw invalid('Program name is required.')
        break
      case 'organisation':
        out[key] = text(raw, 120, 'Organisation')
        break
      case 'supportEmail':
        out[key] = text(raw, 200, 'Support email')
        if (!EMAIL.test(out[key])) throw invalid('Support email is not a valid address.')
        break
      case 'supportPhone':
        out[key] = text(raw, 30, 'Support phone')
        if (!/^\+?[0-9 ()/-]{5,30}$/.test(out[key])) throw invalid('Support phone may contain digits, spaces, +, -, / and brackets.')
        break
      case 'publicUrl': {
        let url
        try {
          url = new URL(String(raw).trim())
        } catch {
          throw invalid('Public URL must be a full URL such as https://stipend.example.org.')
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username) throw invalid('Public URL must be http(s) without query, fragment or credentials.')
        out[key] = `${url.origin}${url.pathname}`.replace(/\/+$/, '')
        break
      }
      case 'defaultDailyLimitCents':
        out[key] = cents(raw, { min: 100, max: 10_000_000, label: 'Default daily cap' })
        break
      case 'cardSpendLimitCents':
        out[key] = cents(raw, { min: 0, max: 100_000_000, label: 'Card spend limit' })
        break
      case 'cardSpendLimitDuration':
        if (!SPEND_LIMIT_DURATIONS.includes(raw)) throw invalid(`Spend limit period must be one of ${SPEND_LIMIT_DURATIONS.join(', ')}.`)
        out[key] = raw
        break
      case 'cardProductId':
        out[key] = text(raw, 32, 'Card product id')
        if (!/^[A-Za-z0-9_-]+$/.test(out[key])) throw invalid('Card product id may contain letters, digits, - and _.')
        break
      case 'mailFrom': {
        out[key] = text(raw, 200, 'Sender')
        const address = /<([^>]+)>\s*$/.exec(out[key])?.[1] ?? out[key]
        if (!EMAIL.test(address)) throw invalid('Sender must be an address or "Name <address>".')
        break
      }
      case 'backupKeep': {
        const n = Number(raw)
        if (!Number.isInteger(n) || n < 1 || n > 365) throw invalid('Backups to keep must be between 1 and 365.')
        out[key] = n
        break
      }
    }
  }
  return out
}

export function applySettings(state, patch) {
  const next = { ...(state.settings?.app || {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  state.settings = { ...(state.settings || {}), app: next }
  return next
}
