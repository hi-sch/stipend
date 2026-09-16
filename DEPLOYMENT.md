# Deployment

How to run Stipend on Kubernetes: what to build, what to create before installing, what each
switch does, and what to check afterwards.

Stipend is one Node process serving the API and the built frontend. State lives in
PostgreSQL. Nothing is written to the container filesystem, so it runs with a read-only
root.

- [Before you start](#before-you-start)
- [1. Build and push the image](#1-build-and-push-the-image)
- [2. Create the secrets](#2-create-the-secrets)
- [3. Install](#3-install)
- [4. Ingress and TLS](#4-ingress-and-tls)
- [5. Single sign-on](#5-single-sign-on)
- [6. Two-operator approval](#6-two-operator-approval)
- [7. Backups](#7-backups)
- [8. Cost allocation](#8-cost-allocation)
- [Values reference](#values-reference)
- [Environment variables](#environment-variables)
- [Migrations](#migrations)
- [Capacity and connections](#capacity-and-connections)
- [Upgrades and rollback](#upgrades-and-rollback)
- [Verifying an install](#verifying-an-install)
- [Troubleshooting](#troubleshooting)

## Before you start

| Requirement | Why |
|---|---|
| Kubernetes 1.27+ | Chart uses standard workload APIs only |
| [CloudNativePG](https://cloudnative-pg.io) operator | The chart creates a `Cluster`; without the operator that object is never reconciled. Skip only if you point at an external database |
| A container registry the cluster can pull from | `image.repository` has no default |
| An ingress controller | Optional. Without one the Service is reachable in-cluster or through `kubectl port-forward` |
| A Lithic API key | Sandbox or production |

PostgreSQL 16 or later. The chart's CloudNativePG cluster satisfies this; an external
database has to meet it.

## 1. Build and push the image

```bash
docker build -t ghcr.io/your-org/stipend:0.1.0 .
docker push ghcr.io/your-org/stipend:0.1.0
```

The build compiles the frontend and produces a runtime image containing `dist/`, `server/`,
the shared engine in `src/lib/` and the demo seed in `src/data/`. `libxml2-utils` is
installed because inbound `pain.001` and `camt.056` files are validated against the ISO 20022
schemas with `xmllint`; without it the server starts but reports the validator as
unavailable and accepts agency files unvalidated.

The image runs as the `node` user and needs no writable filesystem.

## 2. Create the secrets

The chart never holds a secret value. It references Secrets you create with whatever you
already run — sealed-secrets, external-secrets, SOPS. Only the Lithic one is required.

```bash
# Required.
kubectl create secret generic stipend-lithic \
  --from-literal=LITHIC_API_KEY=... 

# Strongly recommended. Encrypts connection HMAC secrets and Lithic signing secrets at rest.
kubectl create secret generic stipend-encryption \
  --from-literal=STIPEND_SECRET_KEY="$(openssl rand -base64 32)"

# Optional: notification email.
kubectl create secret generic stipend-smtp \
  --from-literal=SMTP_URL=smtps://user:pass@smtp.example.org:465

# Required only when sso.enabled=true.
kubectl create secret generic stipend-oidc \
  --from-literal=OIDC_CLIENT_SECRET=...
```

**About `STIPEND_SECRET_KEY`.** Without it, connection HMAC secrets and the ASA, webhook, 3DS
and tokenization secrets are stored in clear, and a database dump is a full key compromise.
Three things follow from how it works:

- Every replica must use the same key. A pod started with a different key, or none, cannot
  read what the others wrote.
- Losing it loses every stored secret. Keep it wherever you keep `LITHIC_API_KEY`.
- Turning it on later is safe. Values already in the database keep working and are encrypted
  the next time they are written.

Rotating it is not a supported operation today: there is no re-encryption pass, so a new key
makes existing sealed values unreadable. Treat it as permanent for the life of the database.

## 3. Install

```bash
helm upgrade --install stipend deploy/helm/stipend \
  --set image.repository=ghcr.io/your-org/stipend \
  --set image.tag=0.1.0 \
  --set secrets.encryptionSecretName=stipend-encryption
```

Defaults give you two replicas, a three-instance Postgres cluster with synchronous
replication and anti-affinity, a ClusterIP Service, a PodDisruptionBudget, no ingress and no
single sign-on. `image.repository` is the only value with no default; install fails with a
clear message rather than pulling a placeholder.

Reach it before there is an ingress:

```bash
kubectl port-forward svc/stipend-stipend 5175:80
```

On first start the server migrates, seeds a demo program and prints an operator login. Set
`STIPEND_ADMIN_PASSWORD` to choose it. Seeding is skipped when the database already holds a
program, so a restart never writes demo data over real data.

Then open **Admin → Settings** and set the program name, support contact and public URL.

## 4. Ingress and TLS

```bash
helm upgrade --install stipend deploy/helm/stipend \
  --set image.repository=ghcr.io/your-org/stipend \
  --set ingress.enabled=true \
  --set ingress.host=stipend.example.org \
  --set ingress.annotations."cert-manager\.io/cluster-issuer"=letsencrypt-production
```

The ingress host also becomes `PUBLIC_URL`, which Lithic hook and webhook enrollment and
email links use. Override it with `--set publicUrl=https://…` when something else terminates
traffic.

`trustProxy` is **true** by default, which is what you want behind an ingress: the client
address is read from the right-hand end of `X-Forwarded-For` rather than from the socket.
Without it every external request appears to come from the ingress controller and the
per-source sign-in rate limit cannot tell one client from another. Set it to `false` only if
you expose the Service directly, where the socket address is the truth and the header is
whatever the caller typed.

TLS also switches the session cookie to `Secure`.

## 5. Single sign-on

Operators federate; cardholders keep local passwords either way.

```bash
--set sso.enabled=true \
--set sso.issuer=https://auth.example.org/realms/stipend \
--set sso.clientId=stipend \
--set sso.adminGroup=stipend-operators \
--set secrets.oidcSecretName=stipend-oidc
```

Authorization-code flow with PKCE; identity comes from the provider's `userinfo` endpoint.
Leave `adminGroup` empty and every user the provider authenticates becomes an operator —
which is rarely what you want in production.

Register `https://<host>/api/auth/oidc/callback` as the redirect URI.

## 6. Two-operator approval

```bash
--set approvals.required=true
```

Cash rule changes, recalls, cardholder deletion, external payments, settings changes and a
program reset are parked until a second operator approves them. A request cannot be approved
by whoever made it — enforced in the route layer and again by a database constraint.

**Only turn this on for a program with at least two operator accounts.** With one operator
every sensitive change becomes permanently unapprovable, including the settings page you
would use to undo it.

Parked requests appear under **Admin → Approvals**, where a second operator approves or
rejects with a note and then carries the request out.

## 7. Backups

Backups belong to the database, not the application. CloudNativePG takes base backups and
streams WAL to object storage.

```bash
--set postgres.backup.enabled=true \
--set postgres.backup.destinationPath=s3://bucket/stipend \
--set postgres.backup.endpointURL=https://s3.eu-central-1.amazonaws.com \
--set postgres.backup.credentialsSecret=stipend-backup \
--set postgres.backup.retentionPolicy=30d
```

The credentials Secret holds `ACCESS_KEY_ID` and `ACCESS_SECRET_KEY`.

Off by default because it needs credentials. Turn it on for anything holding real money
movement. Restore is a CloudNativePG operation (`Cluster` bootstrap from a recovery source).

**Rehearse it.** An untested backup is not a backup, so there is something to rehearse with:

```bash
deploy/restore-drill.sh                    # against a throwaway database it builds itself
SOURCE_DB=stipend deploy/restore-drill.sh  # against a real one; reads only, restores elsewhere
```

It dumps, restores into a fresh database, and compares every table's row count — then drops
what it made. It is the same shape as the real recovery at a size you can run on a laptop,
and it exercises the part that usually breaks: the dump reaching the restore intact. It talks
to Postgres through `container exec`, so set `PGC` if your container is named something else.

This is not a substitute for rehearsing the CloudNativePG recovery itself against your object
storage, which is the one that has to work at three in the morning.

## 8. Cost allocation

No cost tooling is installed. Every object can carry labels so whatever the platform already
uses for showback can group Stipend's spend.

```bash
--set costAllocation.enabled=true \
--set costAllocation.labels.cost-center=cc-4711 \
--set costAllocation.labels.owner=payments-platform \
--set costAllocation.labels.environment=production
```

Off by default on purpose: labels with invented values are worse than none, because they
land in cost reports looking authoritative.

The workload declares CPU and memory requests, and a memory limit, but deliberately **no CPU
limit**. Throttling an authorizer that has to answer inside the ASA deadline turns a busy
moment into declined card payments.

## Values reference

| Value | Default | Notes |
|---|---|---|
| `image.repository` | — | **Required** |
| `image.tag` | `.Chart.AppVersion` | |
| `replicaCount` | `2` | |
| `publicUrl` | `""` | Derived from the ingress host when empty |
| `trustProxy` | `true` | Read client address from `X-Forwarded-For` |
| `service.type` / `service.port` | `ClusterIP` / `80` | Container listens on `5175` |
| `ingress.enabled` / `.host` | `false` / `""` | Host required when enabled |
| `ingress.tls.enabled` / `.secretName` | `true` / `stipend-tls` | |
| `podDisruptionBudget.enabled` | `true` (`minAvailable: 1`) | |
| `autoscaling.enabled` | `false` | 2–6 replicas at 70% CPU when on |
| `postgres.enabled` | `true` | Needs the CNPG operator |
| `postgres.instances` | `3` | One primary, two standbys |
| `postgres.storage.size` | `20Gi` | |
| `postgres.parameters.max_connections` | `200` | See [Capacity](#capacity-and-connections) |
| `postgres.parameters.idle_session_timeout` | `10min` | The server reclaims connections the application lost track of |
| `postgres.parameters.idle_in_transaction_session_timeout` | `60s` | Closes a transaction abandoned holding its locks |
| `postgres.backup.*` | disabled | |
| `postgres.external.enabled` | `false` | Use an existing database via `existingSecret` |
| `secrets.lithicSecretName` | `stipend-lithic` | **Required** |
| `secrets.encryptionSecretName` | `""` | Strongly recommended |
| `secrets.smtpSecretName` | `""` | Optional |
| `secrets.oidcSecretName` | `stipend-oidc` | Required when `sso.enabled` |
| `sso.enabled` | `false` | |
| `approvals.required` | `false` | Needs two operator accounts |
| `costAllocation.enabled` | `false` | |
| `lithic.environment` | `sandbox` | `sandbox` or `production` |
| `logging.format` / `.level` | `json` / `info` | `pretty` for local reading |
| `resources` | 100m / 256Mi req, 512Mi mem limit | No CPU limit on purpose |

## Environment variables

The chart sets these; they matter if you run the image outside Kubernetes.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_POOL_MAX` | Pool size per process (default 10) |
| `HOST` / `PORT` | Bind address; the image uses `0.0.0.0:5175` |
| `PUBLIC_URL` | Absolute URL used for hooks, enrollment and email links |
| `LITHIC_API_KEY`, `LITHIC_ENV`, `LITHIC_PRODUCT_ID` | Lithic |
| `STIPEND_SECRET_KEY` | Encrypts stored secrets |
| `STIPEND_SECURE_COOKIES` | `1` marks the session cookie `Secure` |
| `STIPEND_TRUST_PROXY` | `1` reads the client address from `X-Forwarded-For` |
| `STIPEND_REQUIRE_APPROVAL` | `1` turns on two-operator approval |
| `STIPEND_ADMIN_PASSWORD`, `STIPEND_CARDHOLDER_PASSWORD` | First-run passwords |
| `SMTP_URL`, `MAIL_FROM` | Notification email |
| `OIDC_*` | Operator single sign-on |
| `LOG_FORMAT`, `LOG_LEVEL` | Logging |

## Migrations

Migrations run as an **init container** before any application container starts, holding a
Postgres advisory lock. A rollout with several replicas cannot apply the same migration
twice, and no pod serves traffic against a schema that has not been migrated.

Files in `server/migrations/` are applied in order and recorded. Outside Kubernetes:

```bash
npm run migrate
```

There are no down-migrations. A schema change is rolled back by restoring the database, which
is why backups matter before an upgrade that adds migrations.

## Capacity and connections

Each pod opens up to `DATABASE_POOL_MAX` connections (default 10), plus one dedicated
`LISTEN` connection for live updates. Keep this under the database's limit:

```
replicaCount × (DATABASE_POOL_MAX + 1)  <  postgres.parameters.max_connections
```

Defaults: 2 × 11 = 22 against 200. There is room to scale, but check it before raising
`replicaCount` or `autoscaling.maxReplicas` sharply — exhausting connections takes the whole
program down, not one pod.

## Upgrades and rollback

```bash
helm upgrade stipend deploy/helm/stipend --set image.tag=0.2.0
kubectl rollout status deploy/stipend-stipend
```

The Deployment rolls one pod at a time with a PodDisruptionBudget of `minAvailable: 1`.
Readiness gates traffic, so a pod that cannot reach Postgres never receives requests.

```bash
helm rollback stipend
```

Rolling back the chart does **not** roll back the database. If the release you are leaving
added a migration, the old image runs against the new schema. Check what changed before
rolling back across a migration.

## Verifying an install

```bash
kubectl get pods -l app.kubernetes.io/name=stipend
kubectl get cluster                       # CloudNativePG: expect 3 instances, one primary
kubectl logs deploy/stipend-stipend -c migrate

kubectl port-forward svc/stipend-stipend 5175:80
curl -s localhost:5175/api/health/live    # process is serving
curl -s localhost:5175/api/health/ready   # database is reachable
curl -s localhost:5175/api/health         # database, Lithic and XSD validator
```

Then in the console:

- **Admin → Overview** — the setup checklist: Lithic key and reachability, public URL, cards,
  ASA, webhooks, funding.
- **Admin → Settings** — the server configuration table lists every variable as set or
  missing, and never shows secret values. Confirm encryption reports as on.
- **Admin → Audit log** — `GET /api/admin/audit/verify` walks the hash chain and names the
  first entry that does not verify.

## Troubleshooting

**Install fails with `image.repository is required`.** There is deliberately no default.

**Pods pending, `Cluster` never appears.** The CloudNativePG operator is not installed, so
nothing reconciles the database object.

**`This value is encrypted but STIPEND_SECRET_KEY is not set`.** A pod is reading rows
written by a replica that had the key. Give every replica the same Secret.

**Every authorization declines with `MALFORMED_ASA_RESPONSE`.** ASA is enrolled at a URL
Lithic cannot reach. Fix the public URL or disenroll; the operator overview flags this.

**Sign-in rate limiting blocks legitimate users, or fails to block a spray.** Check
`trustProxy` matches reality. Behind an ingress it must be true; exposed directly it must be
false.

**A sensitive change reports that it needs a second operator and nothing happens.**
`approvals.required` is on. The request is under **Admin → Approvals**, waiting for a
different operator.

**`sorry, too many clients already`.** Connections exceeded the database limit. See
[Capacity and connections](#capacity-and-connections), and check for processes holding pools
open — an old port-forwarded dev server counts.

Start by asking which process is holding them, before terminating anything:

```bash
curl -s localhost:5175/api/health | jq .db.pool     # what this process thinks it holds
lsof -nP -p <pid> | grep -c ':5432'                 # what it actually holds
```

A process should never hold more than `DATABASE_POOL_MAX + 1` — the pool, plus one dedicated
`LISTEN` connection for live updates. Anything beyond that is the bug, and the two numbers
disagreeing tells you it is connections the pool has lost track of rather than a pool that is
simply busy.

One such leak was seen during development: a single long-running dev server holding 102
connections against a pool maximum of 10, all idle, which cleared the moment the process was
killed. It has not been reproduced, and these were ruled out by experiment, so they are not
worth re-testing first: Server-Sent Events clients (they subscribe to an in-memory set, not a
connection each), the version stream's reconnect path (`pg` reaps terminated clients
correctly), dev-server restarts (three consecutive restarts held flat at two connections),
idle pooled connections (`idleTimeoutMillis` is set to 30s), and a missing `release()` (every
checkout site releases in a `finally`). The arithmetic that still fits is several abandoned
pools inside one process. If you meet it, capture `lsof` against the offending pid **before**
killing it — that is the evidence this investigation lacked.

Three things now stand between that and an exhausted database, none of which depend on
knowing the cause:

- **The server closes what the application forgets.** `idle_session_timeout` is 10 minutes on
  the chart's cluster. This is the only layer that can reclaim a connection that was checked
  out and never given back: such a connection is invisible to the pool's own idle timeout and
  stays open for the life of the process, so nothing on the client side will ever close it.
  `idle_in_transaction_session_timeout` is 60 seconds, which is a different failure — a
  transaction abandoned mid-flight holding its row locks.
- **The pool says who is holding one.** Every checkout records where it was taken from, and a
  connection held longer than a minute is logged once with that stack. The point is the
  stack: "a connection leaked" is not actionable, "this function took one and never gave it
  back" is.
- **`/api/health` counts them.** `db.pool.held` is how many are checked out right now and
  `oldestMs` how long the oldest has been out. A `held` that only grows, with an `oldestMs`
  in the hours, is the leak — and the pool's own `total`/`idle` cannot show it.

Two connections are meant to be held and exempt themselves per session: the listener behind
live updates, which is idle by design, and a migration holding its advisory lock. Both set
`idle_session_timeout = 0` on their own session and tell the pool not to report them.

**On an external database** (`postgres.external.enabled`), the chart sets no parameters, so
set them yourself — without the first layer a lost connection is never reclaimed:

```sql
ALTER DATABASE stipend SET idle_session_timeout = '10min';
ALTER DATABASE stipend SET idle_in_transaction_session_timeout = '60s';
```
