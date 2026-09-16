import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, printCredentials } from './app.js'

// Production entry: serves the built SPA from dist/ and the API from one Node process.
const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
const env = { ...loadEnvFile(join(root, '.env')), ...process.env }

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
}

function serveStatic(req, res) {
  if (!existsSync(dist)) {
    res.statusCode = 503
    return res.end('Run `npm run build` first.')
  }
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(dist, path)
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
  res.setHeader('Content-Type', TYPES[extname(file)] || 'application/octet-stream')
  if (file.includes(`${join(dist, 'assets')}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  createReadStream(file).pipe(res)
}

function loadEnvFile(file) {
  if (!existsSync(file)) return {}
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => {
        const i = line.indexOf('=')
        return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
      }),
  )
}

// createApp connects, migrates and seeds before it answers anything. A pod that cannot
// reach the database exits here rather than starting and serving errors.
let app
try {
  app = await createApp({ env })
} catch (err) {
  console.error(`Stipend could not start: ${err.message}`)
  process.exit(1)
}

printCredentials(app.firstRunCredentials)

/**
 * Content Security Policy.
 *
 * Every origin here is one the app genuinely needs, and nothing else is allowed:
 *
 *   frame-src   Lithic's card embed. Both environments are listed because the iframe
 *               origin follows LITHIC_ENV, and a policy that silently stops a cardholder
 *               seeing their card number is worse than naming one extra Lithic host.
 *   script-src  Apple's and Google's wallet provisioning scripts, loaded at runtime by
 *               WalletButtons. Without them "Add to wallet" fails.
 *   style-src   'unsafe-inline' is unavoidable: the console sets inline style attributes
 *               in a couple of hundred places, and CSP cannot hash a style attribute.
 *   connect-src the merchant locator's two OpenStreetMap services.
 *   img-src     data: for the inline SVG favicon.
 *
 * This is set here rather than in the dev server: Vite injects inline scripts and a
 * websocket for hot reload, so a policy loose enough for development would not be worth
 * having. Production serves through this file.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://smp-device-content.apple.com https://developers.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://overpass-api.de https://nominatim.openstreetmap.org",
  'frame-src https://sandbox.lithic.com https://api.lithic.com',
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ')

const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', CSP)
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')

  // Only promise HSTS when the request actually arrived over TLS. Sending it over plain
  // HTTP tells a browser to refuse the only scheme that works.
  if (env.STIPEND_SECURE_COOKIES === '1' || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  app.handle(req, res, () => serveStatic(req, res))
})

// Keep-alive slightly above a typical load balancer's idle timeout, so the connection is
// closed by us rather than being reused just as the proxy drops it.
server.keepAliveTimeout = 65_000
server.headersTimeout = 66_000

const port = Number(env.PORT || 5175)
const host = env.HOST || '127.0.0.1'
server.listen(port, host, () => console.log(`Stipend listening on http://${host}:${port}`))

/**
 * Drain on shutdown.
 *
 * Kubernetes sends SIGTERM and removes the pod from the Service at roughly the same
 * moment, so there is a window where requests are still arriving. Stop accepting new
 * connections, let the in-flight ones finish, then close the database. An authorization
 * cut off half-way would leave Lithic waiting and the cardholder staring at a terminal.
 */
let shuttingDown = false

async function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`${signal} received, draining`)

  // Anything that fails to finish inside the grace period is not worth waiting for; the
  // orchestrator is about to send SIGKILL anyway.
  const force = setTimeout(() => {
    console.error('drain timed out, exiting anyway')
    process.exit(1)
  }, 25_000)
  force.unref()

  try {
    await new Promise((resolve) => server.close(resolve))
    await app.close()
    console.log('drained cleanly')
    process.exit(0)
  } catch (err) {
    console.error(`shutdown failed: ${err.message}`)
    process.exit(1)
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

// A rejection nobody handled is a bug, but it must not take a payments process down
// silently: log it with enough detail to find it, and keep serving.
process.on('unhandledRejection', (err) => {
  console.error('unhandled rejection', err instanceof Error ? err.stack : err)
})
