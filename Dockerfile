# Stipend runs as one Node process: the API and the built SPA from the same server.
# Node 24 is required for the built-in test runner and modern runtime features.

FROM node:24-bookworm-slim AS build
WORKDIR /app

# Install with dev dependencies so Vite can build the frontend.
COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.js ./
COPY src ./src
# vite.config.js imports server/lithicPlugin.js, so the server sources are part of the
# frontend build too, not just the runtime image.
COPY server ./server
RUN npm run build

# ----------------------------------------------------------------------------

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ----------------------------------------------------------------------------

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
# Bind every interface: in a container 127.0.0.1 would be unreachable from the kubelet
# probes and from the Service.
ENV HOST=0.0.0.0
ENV PORT=5175
WORKDIR /app

# xmllint validates inbound pain.001 against the ISO 20022 XSDs. Without it the server
# starts but reports the validator as unavailable on /api/health and accepts agency files
# unvalidated, so it is a runtime dependency, not a build-time convenience.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libxml2-utils \
 && rm -rf /var/lib/apt/lists/*

# No init wrapper: Stipend spawns no child processes, so there is nothing to reap, and
# the server installs its own SIGTERM handler to drain in-flight requests.
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
# The server imports the shared engine and the demo seed from src/, so these are runtime
# code, not frontend-only: server/domain.js -> src/lib/auth.js, server/seed.js -> src/data/seed.js.
COPY src/lib ./src/lib
COPY src/data ./src/data

# Writable only where it needs to be. The SQLite data directory is gone; Postgres holds
# state, so the pod can run with a read-only root filesystem.
USER node

EXPOSE 5175

CMD ["node", "server/standalone.js"]
