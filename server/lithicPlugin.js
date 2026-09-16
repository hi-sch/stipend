import { createApp, printCredentials } from './app.js'

/**
 * Mounts the Stipend API on the Vite dev and preview servers.
 *
 * createApp is async: it connects, migrates and seeds before it will answer anything. Vite
 * awaits this hook, so the middleware is only registered once the app is actually ready,
 * and a database that cannot be reached surfaces as a plugin error at startup rather than
 * as a broken request handler.
 */
export function lithicPlugin(env) {
  let starting

  async function attach(server) {
    starting = starting || createApp({ env })
    const app = await starting

    printCredentials(app.firstRunCredentials)
    server.middlewares.use((req, res, next) => {
      app.handle(req, res, next)
    })

    // Give the pool back when the dev server stops, so a restart does not leave
    // connections behind.
    server.httpServer?.once('close', () => {
      app.close().catch(() => {})
    })
  }

  return {
    name: 'stipend-api',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}
