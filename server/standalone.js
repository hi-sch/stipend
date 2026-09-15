import { createServer } from 'node:http'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApp, printCredentials } from './app.js'

// Production entry: serves the built SPA from dist/ and the API from one Node process.
const root = fileURLToPath(new URL('..', import.meta.url))
const dist = join(root, 'dist')
const env = { ...loadEnvFile(join(root, '.env')), ...process.env }
const app = createApp({ env })
printCredentials(app.firstRunCredentials)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
}

const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  app.handle(req, res, () => serveStatic(req, res))
})

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

const port = Number(env.PORT || 5175)
const host = env.HOST || '127.0.0.1'
server.listen(port, host, () => console.log(`Stipend listening on http://${host}:${port}`))
