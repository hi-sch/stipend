import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { lithicPlugin } from './server/lithicPlugin.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // The dev server proxies a secret Lithic key and can reveal PANs; bind to loopback
  // unless HOST is set explicitly (for example HOST=0.0.0.0 inside a container).
  const host = env.HOST || '127.0.0.1'
  return {
    plugins: [react(), lithicPlugin(env)],
    server: { port: 5175, host, strictPort: true },
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) return 'react'
            if (id.includes('@hugeicons')) return 'icons'
            return undefined
          },
        },
      },
    },
    preview: { port: 5175, host, strictPort: true },
  }
})
