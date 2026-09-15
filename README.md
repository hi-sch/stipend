# Stipend

Stipend is a cardholder app and operator console for **envelopes**: social-security and subsidy credits that can only be spent at the merchant categories (and countries) allowed by the paying agency. Agencies keep sending what they already produce — ISO 20022 `pain.001` or JSON — and the money lands on a Lithic card instead of an IBAN.

<p align="center">
    <img src="https://raw.githubusercontent.com/hi-sch/stipend/refs/heads/main/Stipend.png" width="96%" alt="Stipend Screenshot">
</p>

It runs against the **Lithic sandbox** by default. Card data is shown through Lithic's embedded card UI, so PANs never pass through Stipend.

## Run

Requires Node.js 24 (for the built-in `node:sqlite`).

```bash
cp .env.example .env   # set LITHIC_API_KEY (sandbox)
npm install
npm run dev            # http://127.0.0.1:5175
```

On first start the server creates `server/data/stipend.sqlite` with demo data and prints two logins: an operator (`ops@stipend.demo`) and the demo cardholder. Set `STIPEND_ADMIN_PASSWORD` / `STIPEND_CARDHOLDER_PASSWORD` to choose them; generated passwords must be changed at first sign-in.

Then open **Admin → Settings** to set the program name, support contact and public URL, and check the server configuration table for anything missing.

Production-style single process:

```bash
npm run build
npm start              # serves dist/ and the API
```

```bash
npm test               # engine, cash rules, ISO 20022 (incl. XSD), storage, settings, responders and API tests
npm run test:e2e       # builds, starts the production server and drives Chrome through the main flows
```

End-to-end tests use the installed Google Chrome through `playwright-core` (set `CHROME_PATH` to use another Chromium).

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
| Backups to keep | Daily database backups | `STIPEND_BACKUP_KEEP` |

3DS challenge threshold and tokenization policy are set on the ASA and responders page.

## How it works

- **Server is the source of truth.** A small Node API (mounted into Vite in development, `server/standalone.js` in production) owns state, pushes changes to browsers over Server-Sent Events, and is the only place the Lithic key is used.
- **Envelope engine** (`src/lib/auth.js`, `server/domain.js`). Picks the most specific funded envelope that can pay, applies per-connection daily caps, partially approves on capable terminals, and books holds, clearings, reversals, expiries and refunds as idempotent deltas.
- **Lithic** (`server/lithicService.js`). Account holders (KYC_BYO), virtual and physical cards, card-level MCC allowlist and velocity rules kept in sync with funded envelopes, program- and account-level cash rules, ASA, Events API, disputes, tokenizations, 3DS and ledger.
- **Storage.** SQLite (built-in `node:sqlite`, WAL mode). Application state is written in `BEGIN IMMEDIATE` transactions, so several server processes can share one database file; SSE clients on every process refresh within a second. A backup is taken with `VACUUM INTO` at start and daily. An existing `server/data/stipend.json` is migrated automatically.
- **Sessions.** scrypt-hashed passwords, HttpOnly SameSite=Strict cookies, login rate limiting, same-origin checks on every write. Cardholders only see their own data; operators see everything and can open the cardholder app as any cardholder. Changing a password or choosing "sign out other devices" ends all other sessions.
- **Audit log.** Every operator write, sign-in, failed sign-in and cardholder profile change is recorded with actor, target, outcome and IP (secrets and uploads redacted).
- **Email.** Notifications go to an outbox and are delivered over SMTP with retries and backoff; without SMTP they stay queued. Cardholders choose which alert types they receive.
- **Operations.** `GET /api/health` reports database, Lithic and XSD validator status. Logs are JSON lines with a request id (`X-Request-Id`); `LOG_FORMAT=pretty` for local reading.

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
| `server/` | API (`app.js`), business rules (`domain.js`), Lithic integration (`lithicService.js`, `responders.js`, `ledgerRoutes.js`), storage (`db.js`), settings, email, logging, ISO 20022 schemas (`xsd/`) and unit tests |
| `src/pages/`, `src/pages/admin/` | Cardholder app and operator console |
| `src/lib/` | Shared rules: envelope authorization, cash categories, alert types, ISO 20022 builders and parsers |
| `src/i18n/` | Messages and translation catalogs |
| `tests/e2e/` | Browser tests |

## Licence

Copyright 2026, licensed under the [European Union Public Licence v1.2](LICENSE) (EUPL-1.2).
