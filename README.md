# Stipend

Stipend is a cardholder app and operator console for **envelopes**: social-security and subsidy credits that can only be spent at the merchant categories (and countries) allowed by the paying agency. Agencies keep sending what they already produce — ISO 20022 `pain.001` or JSON — and the money lands on a Lithic card instead of an IBAN.

<p align="center">
    <img src="https://raw.githubusercontent.com/hi-sch/stipend/refs/heads/main/Stipend.png" width="96%" alt="Stipend Screenshot">
</p>

It runs against the **Lithic sandbox** by default. Card data is shown through Lithic's embedded card UI, so PANs never pass through Stipend.

## Run

Requires Node.js 24 and a PostgreSQL 16 or later database.

```bash
cp .env.example .env   # set DATABASE_URL and LITHIC_API_KEY (sandbox)
npm install
npm run migrate        # apply the schema
npm run dev            # http://127.0.0.1:5175
```

A database for development, if you do not already have one:

```bash
docker run -d --name stipend-pg -p 5432:5432 \
  -e POSTGRES_USER=stipend -e POSTGRES_PASSWORD=stipend -e POSTGRES_DB=stipend postgres:17
# DATABASE_URL=postgres://stipend:stipend@127.0.0.1:5432/stipend
```

Worth setting on a development database too, because a connection the application loses track
of can only be closed by the server, and a long-running dev server is where that was found:

```sql
ALTER DATABASE stipend SET idle_session_timeout = '10min';
ALTER DATABASE stipend SET idle_in_transaction_session_timeout = '60s';
```

The chart sets both on the cluster it creates; see [DEPLOYMENT.md](DEPLOYMENT.md#troubleshooting).

On first start the server migrates, seeds the demo program and prints two logins: an operator (`ops@stipend.demo`) and the demo cardholder. Set `STIPEND_ADMIN_PASSWORD` / `STIPEND_CARDHOLDER_PASSWORD` to choose them; generated passwords must be changed at first sign-in. Seeding is skipped when the database already holds a program, so a restart never writes demo data over real data.

Then open **Admin → Settings** to set the program name, support contact and public URL, and check the server configuration table for anything missing.

Production-style single process:

```bash
npm run build
npm start              # serves dist/ and the API
```

```bash
npm test               # engine, cash rules, ISO 20022 (incl. XSD), ledger, reconciliation, audit, SSO, API, components and translations
npm run test:e2e       # builds, starts the production server and drives Chrome through the main flows
npm run lint           # correctness rules only: no formatter, no stylistic rewrites
```

Both need `DATABASE_URL`. Tests that assert on program-wide state create and drop a database of their own per run, so they never disturb a database you are working in.

End-to-end tests use the installed Google Chrome through `playwright-core` (set `CHROME_PATH` to use another Chromium).

ESLint is held at 9 on purpose. `eslint-plugin-react` supplies `jsx-uses-vars`, without which everything used only inside JSX reads as an unused import — 267 false findings — and it does not support ESLint 10 yet. `npm outdated` will keep offering the upgrade; it is worth taking only once that plugin follows.

## Deployment

A container image and a Helm chart are in the repository. The full procedure — secrets, ingress, single sign-on, backups, upgrades, capacity and a troubleshooting list — is in **[DEPLOYMENT.md](DEPLOYMENT.md)**. What follows is the short version.

The defaults install a working program with no ingress and no single sign-on. The only value
without a default is the image; install fails with a clear message rather than trying to pull
a placeholder.

```bash
docker build -t ghcr.io/your-org/stipend:0.1.0 .
helm upgrade --install stipend deploy/helm/stipend \
  --set image.repository=ghcr.io/your-org/stipend
kubectl port-forward svc/stipend-stipend 5175:80    # until there is an ingress
```

Turn each piece on as the infrastructure for it exists:

```bash
--set ingress.enabled=true --set ingress.host=stipend.example.org   # also sets PUBLIC_URL
--set publicUrl=https://stipend.example.org                         # if something else terminates TLS
--set sso.enabled=true --set sso.issuer=https://auth.example.org/realms/stipend
--set approvals.required=true                                       # needs two operator accounts
--set costAllocation.enabled=true --set costAllocation.labels.cost-center=cc-4711
--set postgres.backup.enabled=true --set postgres.backup.destinationPath=s3://bucket/stipend
```

- **Database.** The chart creates a [CloudNativePG](https://cloudnative-pg.io) cluster (three instances, synchronous replication, anti-affinity) and the application reads its connection string from the Secret the operator publishes. Point at an existing database instead with `postgres.external.enabled=true`. Continuous backup to object storage is off until you give it a destination and credentials; turn it on for anything holding real money movement.
- **Migrations** run as an init container, behind a Postgres advisory lock, so a rollout with several replicas cannot apply the same migration twice.
- **Probes.** Liveness is `/api/health/live` and does not touch the database, because restarting a pod does not fix a database outage. Readiness is `/api/health/ready` and does, so a pod that cannot reach Postgres leaves the Service instead of answering with errors.
- **Shutdown.** SIGTERM stops new connections, lets in-flight authorizations finish, then closes the database.
- **Cost allocation.** Every object carries `cost-center`, `owner` and `environment` labels, and the workload declares resource requests, so whatever the platform already uses for showback can attribute Stipend's spend. There is a memory limit but deliberately no CPU limit: throttling an authorizer that has to answer inside the ASA deadline turns a busy moment into declined card payments.
- **Secrets** are referenced, never held in the chart. Create them with whatever you already run (sealed-secrets, external-secrets, SOPS).

## Features

### Cardholder app

- **Dashboard.** Spendable total, envelopes by connection (pie with merchant codes), spend chart, top merchants and the cash limit when cash is enabled.
- **Incoming.** Credits by connection, recalls, and the Stipend IBAN and beneficiary reference to give to agencies.
- **Transactions.** Every authorization with the envelope that paid, or the reason it was declined.
- **Restrictions.** Which envelope pays which merchant category and country; try a purchase (sandbox) and online verification (3DS).
- **Card.** Card details through Lithic's embed, freeze, PIN, Apple/Google Wallet, wallet tokens, and cash: request a budget or see the limit, what is left and when it resets.
- **Disputes.** File, add evidence, follow and withdraw.
- **Settings.** Language; contact details (email to sign in, which needs the current password to change, and mobile phone for security codes, both synced to the Lithic account holder); payment details; email alerts by type with delivery status; program support contact; password; sign out other devices.
- **Notifications** in the app, copied to email when alerts are on.

### Operator console

- **Overview.** Program setup checklist (Lithic key and reachability, public URL, cards, ASA, webhooks, funding) and operations (health, backups, email delivery).
- **Connections.** Paying agencies with protocol, MCC allowlist, country allowlist, daily cap, whether cash is allowed, hook URLs, HMAC secret, samples and file upload.
- **Credits.** Credit log with `pain.002` reports and recalls.
- **Cardholders.** Create, issue cards, open the app as a cardholder, and add cardholders to cash rules one by one or in bulk; manage cash rules.
- **Approvals.** What is waiting for a second operator, what it will change and who asked for it; approve or reject with a note, then carry it out. Empty unless two-operator approval is on.
- **Declines, Auth rules, ASA and responders, Integrations (Lithic events), Ledger, Cases, Sandbox tools, Audit log.**
- **Settings** (header link). Personal preferences and program configuration, see [Configuration](#configuration).

The interface is available in English, German, French, Dutch, Spanish, Italian, Polish, Swedish and Finnish. Operators pick a country scope in Settings; the overview, connections, credits and connection presets then show that country's paying agencies.

## Configuration

Two places:

- **`.env` on the server** (see `.env.example`) holds secrets and process settings: `LITHIC_API_KEY`, `LITHIC_ENV`, Lithic signing secrets, `SMTP_URL`, `HOST`/`PORT`, storage paths, logging and first-run passwords. Admin → Settings lists every variable as set or missing and never shows secret values.
- **Admin → Settings** stores program settings in the database. Each falls back to its `.env` variable, then to a default:

| Setting | Used for | `.env` fallback |
|---|---|---|
| Program name, organisation, support email and phone | Shown to cardholders under Help and contact | — |
| Public URL | Hook URLs, ASA / responder / webhook enrollment, links in emails | `PUBLIC_URL` |
| Default daily cap | New connections | — |
| Card spend limit and period, physical card product id | Newly issued cards | `LITHIC_PRODUCT_ID` |
| Email sender, test email | Notification emails | `MAIL_FROM` |

3DS challenge threshold and tokenization policy are set on the ASA and responders page.

## How it works

- **Server is the source of truth.** A small Node API (mounted into Vite in development, `server/standalone.js` in production) owns state, pushes changes to browsers over Server-Sent Events, and is the only place the Lithic key is used. One payload backs every page, so what it carries is deliberate: rows name the cardholder they belong to rather than being joined against a directory in the browser, the operator list holds only the fields the lists show, and a page that needs a whole cardholder asks for one. A convenient field added back here is sent to every operator on every update, for every cardholder in the program.
- **Envelope engine** (`src/lib/auth.js`, `server/domain.js`). Picks the most specific funded envelope that can pay, applies per-connection daily caps, partially approves on capable terminals, and books holds, clearings, reversals, expiries and refunds as idempotent deltas.
- **Lithic** (`server/lithicService.js`). Account holders (KYC_BYO), virtual and physical cards, card-level MCC allowlist and velocity rules kept in sync with funded envelopes, program- and account-level cash rules, ASA, Events API, disputes, tokenizations, 3DS and ledger.
- **Storage.** PostgreSQL. Each entity is a table with real constraints, so the rules that matter are enforced by the database and not only by the code: a replayed `pain.001` is rejected by a unique index on `(connection_id, end_to_end_id)`, an envelope is unique per cardholder and connection, and one transaction can have only one open dispute. An authorization locks just that cardholder's envelopes with `SELECT … FOR UPDATE`, so purchases on different cards do not queue behind each other. Migrations in `server/migrations/` are applied in order under an advisory lock, so several replicas starting at once cannot race. Backups belong to the database (CloudNativePG takes base backups and streams WAL) rather than to the application.
- **Double-entry ledger.** Every movement of value — credits, spend, refunds, recalls, operator allocations — is a balanced journal entry, and a deferred constraint refuses an entry that does not balance at commit. Envelope balances are a projection of that journal, not the record itself, which is what makes a drifted balance detectable instead of invisible. Postings are idempotent: replaying an ASA decision or a Lithic sync recomputes the same key and is skipped rather than doubling the money.
- **Live updates.** A version counter in Postgres is bumped inside the writing transaction and announced with `NOTIFY`; every replica listens and forwards it to its own SSE clients, so a write on one pod reaches a browser connected to another. A rolled-back write announces nothing.
- **Sessions.** scrypt-hashed passwords, HttpOnly SameSite=Strict cookies, login rate limiting, same-origin checks on every write. Cardholders only see their own data; operators see everything and can open the cardholder app as any cardholder. Changing a password or choosing "sign out other devices" ends all other sessions.
- **Audit log.** Every operator write, sign-in, failed sign-in and cardholder profile change is recorded with actor, target, outcome and IP (secrets and uploads redacted). Each entry carries the hash of the entry before it, and the table refuses `UPDATE` and `DELETE` outright, so an edited, deleted or reordered row is detectable. `GET /api/admin/audit/verify` walks the chain and names the first entry that does not verify.
- **Reconciliation.** On a schedule and on demand, Stipend asks two questions: does it agree with itself (every envelope balance against the journal), and does it agree with Lithic (transactions in both directions, with amounts and statuses). Differences become breaks an operator resolves or accepts, with who decided and why. Nothing is repaired automatically — money that disagrees is a decision, not a cleanup.
- **Two-operator approval.** Optional (`STIPEND_REQUIRE_APPROVAL=1`). Cash rule changes, recalls, cardholder deletion, external payments and settings changes are parked until a second operator approves them. A request cannot be approved by the operator who made it — enforced in the route layer and again by a database constraint — so leave it off for a program with a single operator account.
- **Rate limiting.** Sign-in is limited per account and per source address, so neither a brute force against one account nor a spray across many runs unthrottled. The endpoints that accept unauthenticated requests — ASA, the agency hooks, Lithic webhooks and the responders — each carry a flood ceiling, checked before the request body is read. These are ceilings, not quotas: every one of those endpoints verifies an HMAC signature before doing any work, and the limits sit far above real traffic because they are held per replica. Set `STIPEND_TRUST_PROXY=1` behind a proxy or ingress, or every request will appear to come from the same address and the per-source limits will not distinguish clients.
- **Email.** Notifications go to an outbox and are delivered over SMTP with retries and backoff; without SMTP they stay queued. Cardholders choose which alert types they receive.
- **Operations.** `GET /api/health` reports database, Lithic and XSD validator status, and how many connections this process is holding — `held` growing with an `oldestMs` in the hours is a connection nobody gave back, which the pool's own totals cannot show. Logs are JSON lines with a request id (`X-Request-Id`); `LOG_FORMAT=pretty` for local reading.

## Cash rules

Cash is off for every card. Operators define cash rules (a limit per day, week or month, e.g. the seeded "Standard cash allowance" of 100 EUR per month) and add cardholders to them from Admin → Cardholders. A rule's limit applies to each member's account separately, and changing a rule changes it for all members. Cardholders can ask for cash on the Card page; requests show in Cases and on the cardholder page. Cash is paid only from envelopes whose connection allows cash.

- **What counts as cash:** ATM and bank-counter withdrawals (MCC 6011, 6010), quasi-cash (6050, 6051: currency exchange, money orders, travellers cheques, crypto), money transfers and stored-value loads (4829, 6529, 6530, 6534, 6540), and cashback at any merchant. Visa and Mastercard mark cashback with processing code 09 and the cashback amount in DE54 (amount type 40); Lithic passes it on as `cash_amount`. A supermarket keeps MCC 5411, so MCC rules alone cannot see cashback.
- **Stipend (ASA):** takes the whole amount as cash for cash categories, otherwise `cash_amount`. It checks the rule's remaining limit and takes the cash part from a cash-enabled envelope; the rest of the purchase follows the normal envelope rules.
- **Lithic (works without ASA):** two program-level `CONDITIONAL_ACTION` rules decline `CASH_AMOUNT > 0` and the cash categories, with members' cards in `excluded_card_tokens`. Each cash rule becomes two account-level `VELOCITY_LIMIT` rules shared by its members' accounts: `limit_cash_amount` for ATM, cash and cashback, and `limit_amount` with `filters.include_mccs` for quasi-cash and money transfers, which carry no `cash_amount`. Members' card MCC allowlists include the cash categories.
- **Limits:** on Lithic alone the two velocity rules count separately, so a member could use the limit once for ATM/cashback and once more for quasi-cash; with ASA enrolled, Stipend enforces one combined limit. Lithic's sandbox cannot simulate cashback, so cashback test purchases are decided by Stipend alone.

## Public endpoints

Reachable by Lithic and paying agencies (expose them with a tunnel in development and set the public URL in Admin → Settings):

| Endpoint | Purpose |
|---|---|
| `POST /api/asa` | Auth Stream Access responder. Verifies `webhook-signature` with the secret fetched from `GET /v1/auth_stream/secret`. |
| `POST /api/webhooks/lithic` | Events API receiver. Verifies every stored subscription secret, 5-minute replay window, de-duplicates by `webhook-id`. |
| `POST /api/hooks/credits/:connectionId` | Credits. `pain.001` (batches supported) or JSON (`credits: [...]` for batches). HMAC-SHA256 in `X-Stipend-Signature: sha256=…`. Beneficiaries are matched by reference (`beneficiary_ref` / `Cdtr/Id/PrvtId/Othr/Id`) or Stipend IBAN (`CdtrAcct/IBAN`). Returns per-transaction status; send `Accept: application/xml` for a `pain.002`. |
| `POST /api/hooks/recalls/:connectionId` | Recalls (`camt.056`). Takes back unspent envelope money, reverses the book transfer, returns `camt.029`. |
| `POST /api/responders/three-ds` | 3DS decisioning: declines merchants no envelope pays, challenges amounts above the policy threshold. |
| `POST /api/responders/tokenization` | Tokenization decisioning: only open cards; follows the wallet recommendation or a stricter policy. |
| `GET /api/health` | Health check for load balancers and monitoring. |

Rejections use ISO reason codes: `FF01` format, `AM05` duplicate EndToEndId, `AM11` currency, `AM12` amount, `BE06` unknown beneficiary. Incoming `pain.001` and `camt.056` files are validated against the official ISO 20022 schemas (`server/xsd/`, via `xmllint`) and then against business rules (`NbOfTxs`, `CtrlSum`, amounts). Generated `pain.002` and `camt.029` reports are covered by schema tests. Refunds that cannot be matched to the envelope that paid are queued for an operator (Cases → Allocate).

## Lithic features in use

Cards (create, update, spend limits, convert to physical, reissue, renew), embedded card UI and PIN setting, account holders (create, get, update), auth rules v2 (conditional action on MCC and cash amount, velocity limits with cash amount and MCC filters, card-, account- and program-level scopes with excluded cards, results, performance report, backtests, activate/deactivate), ASA (enroll, disenroll, status, secret fetch/rotate, partial approval, cash amount, balance inquiry), Events API (subscriptions, secrets, recover, replay, send example, events list, delivery attempts), transactions (sync, simulate authorize/clearing/void/return/return reversal/authorization advice, expire authorization, enhanced commercial data), disputes (file, status, withdraw, evidence upload/delete, managed disputes list), tokenizations (list, pause, unpause, deactivate, simulate), web push provisioning, 3DS (simulate, OTP challenge), ledger (financial accounts, balances, account activity, book transfers and reversal, sandbox ACH receipt funding, settlement summary), transaction monitoring cases, 3DS and tokenization decisioning responders, holds and external payments on financial accounts, idempotency keys on account-holder and card creation.

## Sandbox notes

- Lithic bills this program in **USD**. Amounts are labelled as euros and mapped 1:1 in cents.
- Without a tunnel, leave ASA **disenrolled**. Stipend then runs its envelope engine right after each sandbox authorization and reverses purchases no envelope can pay. If ASA is enrolled at a URL Lithic cannot reach, every authorization declines with `MALFORMED_ASA_RESPONSE`; the operator overview flags this.
- The program-level cash rules apply to **every card in the Lithic program**, including cards not created by Stipend. They are created on the first cash change or with "Sync with Lithic" on the Cardholders page.
- `KYC_BYO` account holders use a placeholder US address because Lithic sandbox KYC accepts `USA` only.
- Envelope credits post a `DISBURSE` book transfer only when the program ISSUING account exists and is funded (Ledger → simulate ACH receipt).
- EBICS transport is not implemented: an EBICS host is operated by a bank, not by a card program. Agencies post files to the hook, or operators upload files they received over EBICS on the connection page.

## Project layout

| Path | Contents |
|---|---|
| `server/` | API (`app.js`), the cardholder's own routes (`cardholderRoutes.js`), business rules (`domain.js`), Lithic integration (`lithicService.js`, `responders.js`, `ledgerRoutes.js`), settings, email, logging, ISO 20022 schemas (`xsd/`) and unit tests |
| `server/db/` | Storage: pool and transactions, repositories, double-entry ledger, audit chain, sessions, approvals, reconciliation, secret encryption, migrations runner |
| `server/migrations/` | Schema, applied in order under an advisory lock |
| `deploy/helm/stipend/` | Chart: Deployment, Service, Ingress, CloudNativePG cluster |
| `src/pages/`, `src/pages/admin/` | Cardholder app and operator console |
| `src/lib/` | Shared rules: envelope authorization, cash categories, alert types, ISO 20022 builders and parsers |
| `src/i18n/` | Messages and translation catalogs |
| `src/components/` | Shared interface pieces, with their tests beside them |
| `tests/e2e/` | Browser tests |
| `deploy/restore-drill.sh` | Dumps a database, restores it into a fresh one and compares every row count |
| `eslint.config.js`, `tsconfig.json` | Correctness-only lint rules, and the JSX transform the test runner uses |

## Licence

Copyright 2026, licensed under the [European Union Public Licence v1.2](LICENSE) (EUPL-1.2).
