const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

/**
 * JSON-lines logger. One object per line so log shippers can parse it; set LOG_FORMAT=pretty
 * for a readable local format and LOG_LEVEL to filter.
 */
export function createLogger({ level = 'info', format = 'json', base = {}, stream = process.stdout } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info
  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return
    const entry = { ts: new Date().toISOString(), level: lvl, msg: String(msg), ...base, ...normalize(fields) }
    if (format === 'pretty') {
      const { ts, level: l, msg: m, ...rest } = entry
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''
      stream.write(`${ts.slice(11, 19)} ${l.toUpperCase().padEnd(5)} ${m}${extra}\n`)
    } else {
      stream.write(`${JSON.stringify(entry)}\n`)
    }
  }
  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger({ level, format, base: { ...base, ...fields }, stream }),
  }
}

export function loggerFromEnv(env = {}) {
  return createLogger({ level: env.LOG_LEVEL || 'info', format: env.LOG_FORMAT || 'json' })
}

function normalize(fields) {
  if (fields instanceof Error) return { err: { message: fields.message, stack: fields.stack } }
  const out = {}
  for (const [k, v] of Object.entries(fields || {})) {
    out[k] = v instanceof Error ? { message: v.message, stack: v.stack, status: v.status } : v
  }
  return out
}
