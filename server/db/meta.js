import { secretBox } from './secrets.js'

/**
 * Program singletons and saved settings.
 *
 * Two tables, for two different things. `program_meta` holds one row per singleton the
 * program needs (the operator, Lithic status, the enrollment secrets, responder policy).
 * `app_settings` holds one row per setting an operator edits, so saving two settings at
 * once cannot have one overwrite the other.
 *
 * settings.js is deliberately left alone: it takes a state-shaped object and resolves
 * saved value, then environment variable, then default. loadSettingsState() rebuilds that
 * shape from these tables, so the resolution rules and their tests stay exactly as they
 * were.
 */

export async function getMeta(client, key, fallback = null) {
  const { rows } = await client.query('SELECT value FROM program_meta WHERE key = $1', [key])
  return rows.length ? rows[0].value : fallback
}

export async function setMeta(client, key, value) {
  await client.query(
    `INSERT INTO program_meta (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  )
  return value
}

/**
 * Merge fields into an object-valued singleton. The merge happens in the database so two
 * writers updating different fields do not clobber each other.
 */
export async function patchMeta(client, key, fields) {
  const { rows } = await client.query(
    `INSERT INTO program_meta (key, value, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = program_meta.value || EXCLUDED.value, updated_at = now()
     RETURNING value`,
    [key, JSON.stringify(fields)],
  )
  return rows[0].value
}

// The program settings blob mixes secrets with plain configuration. Only these are sealed;
// asaMode and the responder policy are settings, not secrets, and stay readable.
const SECRET_KEYS = ['asaSecret', 'threeDsSecret', 'tokenizationSecret']

function mapSecrets(settings, fn) {
  if (!settings || typeof settings !== 'object') return settings
  const out = { ...settings }

  for (const key of SECRET_KEYS) {
    if (typeof out[key] === 'string' && out[key]) out[key] = fn(out[key])
  }
  // Each subscription has its own signing secret, keyed by subscription token.
  if (out.webhookSecrets && typeof out.webhookSecrets === 'object') {
    out.webhookSecrets = Object.fromEntries(
      Object.entries(out.webhookSecrets).map(([token, secret]) => [token, typeof secret === 'string' && secret ? fn(secret) : secret]),
    )
  }
  return out
}

/**
 * Everything under `settings` in the old document: secrets, ASA mode, responder policy.
 * Secrets are sealed on the way in and opened on the way out, so no caller has to
 * remember to do it.
 */
export const getProgramSettings = async (client) => mapSecrets(await getMeta(client, 'settings', {}), (v) => secretBox().open(v))

export const patchProgramSettings = (client, fields) => patchMeta(client, 'settings', mapSecrets(fields, (v) => secretBox().seal(v)))

export async function getAppSettings(client) {
  const { rows } = await client.query('SELECT key, value FROM app_settings')
  return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

/** A null or empty value clears the saved setting so the env var or default applies again. */
export async function applyAppSettings(client, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === '') {
      await client.query('DELETE FROM app_settings WHERE key = $1', [key])
      continue
    }
    await client.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    )
  }
  return getAppSettings(client)
}

/**
 * The shape settings.js expects. Rebuilt from the tables rather than changing that module,
 * so its resolution order and its tests are untouched.
 */
export async function loadSettingsState(client) {
  // Sequential on purpose: these may run on a transaction client, which can only have
  // one query in flight at a time.
  const app = await getAppSettings(client)
  const settings = await getProgramSettings(client)
  const operator = await getMeta(client, 'operator', null)
  return { settings: { ...settings, app }, operator }
}
