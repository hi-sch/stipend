import { createApp, printCredentials } from './app.js'

/** Mounts the Stipend API on the Vite dev and preview servers. */
export function lithicPlugin(env) {
  let app
  function attach(server) {
    app = app || createApp({ env })
    printCredentials(app.firstRunCredentials)
    server.middlewares.use((req, res, next) => {
      app.handle(req, res, next)
    })
  }
  return {
    name: 'stipend-api',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}
