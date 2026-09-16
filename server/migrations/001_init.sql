-- Stipend schema. Replaces the single JSON state document with real tables.
--
-- Money is always bigint cents, never floating point. Identifiers keep the prefixed
-- string form the application already generates (env_, crd_, txn_, cash_) so existing
-- code and URLs do not change meaning.
--
-- Three groups of tables:
--   1. program state  - what used to live in the state document
--   2. ledger         - double-entry journal; envelope balances are derived from it
--   3. controls       - tamper-evident audit, reconciliation breaks, maker-checker

-- schema_migrations is created and owned by the migration runner (server/db/migrate.js),
-- which must be able to read it before any migration has run.

-- ---------------------------------------------------------------- program state

-- Program configuration that Admin -> Settings writes. One row per setting key so a
-- concurrent write to two settings cannot clobber the other.
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Program-level singletons that are not user-facing settings: seed timestamp, Lithic
-- connection status, operator identity, ASA mode and the enrollment secrets.
CREATE TABLE program_meta (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                   text PRIMARY KEY,
  email                text NOT NULL,
  name                 text NOT NULL,
  role                 text NOT NULL CHECK (role IN ('admin', 'cardholder')),
  -- Null for operators who sign in through the identity provider only.
  password_hash        text,
  must_change_password boolean NOT NULL DEFAULT false,
  cardholder_id        text,
  -- OIDC identity. Operators federate; cardholders keep local passwords.
  oidc_issuer          text,
  oidc_subject         text,
  last_login_at        timestamptz,
  disabled_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  -- An account must be reachable by one method or the other.
  CONSTRAINT users_has_credential CHECK (
    password_hash IS NOT NULL OR (oidc_issuer IS NOT NULL AND oidc_subject IS NOT NULL)
  )
);

-- Email is the login handle, compared case-insensitively.
CREATE UNIQUE INDEX users_email_key ON users (lower(email));
CREATE UNIQUE INDEX users_oidc_key ON users (oidc_issuer, oidc_subject)
  WHERE oidc_issuer IS NOT NULL;

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip         text,
  user_agent text
);

CREATE INDEX sessions_user ON sessions (user_id);
CREATE INDEX sessions_expires ON sessions (expires_at);

CREATE TABLE cardholders (
  id              text PRIMARY KEY,
  first_name      text NOT NULL,
  last_name       text NOT NULL,
  email           text NOT NULL,
  phone           text,
  city            text,
  country         text,
  iban_ref        text,
  beneficiary_ref text,
  iban            text,
  lithic_account  uuid,
  -- Card and KYC are Lithic's shapes; Stipend stores them verbatim and never the PAN.
  card            jsonb NOT NULL DEFAULT '{}'::jsonb,
  kyc             jsonb NOT NULL DEFAULT '{"status":"NOT_SUBMITTED"}'::jsonb,
  prefs           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX cardholders_email_key ON cardholders (lower(email));
CREATE UNIQUE INDEX cardholders_card_token ON cardholders ((card ->> 'token'))
  WHERE card ->> 'token' IS NOT NULL;

ALTER TABLE users
  ADD CONSTRAINT users_cardholder_fk FOREIGN KEY (cardholder_id)
  REFERENCES cardholders (id) ON DELETE CASCADE;

CREATE TABLE connections (
  id               text PRIMARY KEY,
  name             text NOT NULL,
  agency           text,
  country          text,
  system           text,
  protocol         text NOT NULL,
  purpose          text,
  status           text NOT NULL DEFAULT 'live',
  mccs             text[] NOT NULL DEFAULT '{}',
  countries        text[] NOT NULL DEFAULT '{}',
  daily_limit_cents bigint NOT NULL DEFAULT 15000 CHECK (daily_limit_cents >= 0),
  cash_allowed     boolean NOT NULL DEFAULT false,
  hook_path        text,
  hmac_secret      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_rules (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  limit_cents bigint NOT NULL CHECK (limit_cents > 0),
  period      text NOT NULL CHECK (period IN ('DAY', 'WEEK', 'MONTH')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Cash state used to live on the cardholder document. A row here means cash is or was
-- considered for that cardholder; status drives what the card may do.
CREATE TABLE cardholder_cash (
  cardholder_id     text PRIMARY KEY REFERENCES cardholders (id) ON DELETE CASCADE,
  status            text NOT NULL CHECK (status IN ('NONE', 'REQUESTED', 'APPROVED', 'REJECTED', 'REVOKED')),
  rule_id           text REFERENCES cash_rules (id) ON DELETE RESTRICT,
  requested_cents   bigint CHECK (requested_cents IS NULL OR requested_cents > 0),
  requested_period  text CHECK (requested_period IS NULL OR requested_period IN ('DAY', 'WEEK', 'MONTH')),
  reason            text,
  requested_at      timestamptz,
  decided_at        timestamptz,
  decided_by        text,
  note              text,
  -- An approved cardholder must point at the rule that grants the limit.
  CONSTRAINT cash_approved_has_rule CHECK (status <> 'APPROVED' OR rule_id IS NOT NULL)
);

CREATE INDEX cardholder_cash_rule ON cardholder_cash (rule_id) WHERE status = 'APPROVED';

CREATE TABLE envelopes (
  id              text PRIMARY KEY,
  cardholder_id   text NOT NULL REFERENCES cardholders (id) ON DELETE CASCADE,
  connection_id   text NOT NULL REFERENCES connections (id) ON DELETE RESTRICT,
  connection_name text NOT NULL,
  -- Cached projections of the journal. reconcile() proves them against journal_lines;
  -- a mismatch is a break, never something the application silently repairs.
  balance_cents   bigint NOT NULL DEFAULT 0,
  spent_cents     bigint NOT NULL DEFAULT 0 CHECK (spent_cents >= 0),
  mccs            text[] NOT NULL DEFAULT '{}',
  countries       text[] NOT NULL DEFAULT '{}',
  color           text,
  received_at     timestamptz,
  end_to_end_id   text,
  remittance      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- One envelope per connection per cardholder: applyCredit() tops up rather than forking.
CREATE UNIQUE INDEX envelopes_holder_connection ON envelopes (cardholder_id, connection_id);
CREATE INDEX envelopes_holder ON envelopes (cardholder_id);

CREATE TABLE credits (
  id              text PRIMARY KEY,
  connection_id   text NOT NULL REFERENCES connections (id) ON DELETE RESTRICT,
  cardholder_id   text NOT NULL REFERENCES cardholders (id) ON DELETE CASCADE,
  envelope_id     text REFERENCES envelopes (id) ON DELETE SET NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),
  recalled_cents  bigint NOT NULL DEFAULT 0 CHECK (recalled_cents >= 0),
  currency        text NOT NULL DEFAULT 'EUR',
  end_to_end_id   text NOT NULL,
  msg_id          text,
  protocol        text,
  purpose         text,
  remittance      text,
  status          text NOT NULL DEFAULT 'SETTLED',
  method          text,
  lithic_category text,
  lithic_transfer jsonb,
  recall          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credits_recall_within_amount CHECK (recalled_cents <= amount_cents)
);

-- isDuplicateCredit() became a constraint: the database refuses a replayed pain.001.
CREATE UNIQUE INDEX credits_idempotency ON credits (connection_id, end_to_end_id);
CREATE INDEX credits_holder ON credits (cardholder_id, created_at DESC);

CREATE TABLE transactions (
  id                 text PRIMARY KEY,
  cardholder_id      text NOT NULL REFERENCES cardholders (id) ON DELETE CASCADE,
  card_token         text,
  kind               text NOT NULL DEFAULT 'PURCHASE',
  status             text NOT NULL,
  result             text,
  detailed_results   text[] NOT NULL DEFAULT '{}',
  merchant           jsonb NOT NULL DEFAULT '{}'::jsonb,
  currency           text NOT NULL DEFAULT 'EUR',
  requested_cents    bigint NOT NULL DEFAULT 0,
  amount_cents       bigint NOT NULL DEFAULT 0,
  -- Which envelope pays the goods part and which pays the cash part.
  envelope_id        text REFERENCES envelopes (id) ON DELETE SET NULL,
  cash_envelope_id   text REFERENCES envelopes (id) ON DELETE SET NULL,
  cash_cents         bigint NOT NULL DEFAULT 0 CHECK (cash_cents >= 0),
  -- What is currently booked, so replays only move the difference.
  debited_cents      bigint NOT NULL DEFAULT 0,
  cash_debited_cents bigint NOT NULL DEFAULT 0,
  unallocated_cents  bigint NOT NULL DEFAULT 0,
  review             text,
  allocated_by       text,
  note               text,
  asa_result         text,
  asa_response       jsonb,
  source             text,
  live               boolean NOT NULL DEFAULT false,
  events             jsonb NOT NULL DEFAULT '[]'::jsonb,
  lithic             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX transactions_holder_created ON transactions (cardholder_id, created_at DESC);
CREATE INDEX transactions_envelope ON transactions (envelope_id);
-- cashUsageFor() scans a cardholder's cash spend inside the current period.
CREATE INDEX transactions_cash ON transactions (cardholder_id, created_at)
  WHERE cash_cents > 0;
-- Unresolved allocation work an operator still owes.
CREATE INDEX transactions_unallocated ON transactions (cardholder_id)
  WHERE unallocated_cents <> 0;

CREATE TABLE disputes (
  id            text PRIMARY KEY,
  cardholder_id text NOT NULL REFERENCES cardholders (id) ON DELETE CASCADE,
  transaction_id text REFERENCES transactions (id) ON DELETE SET NULL,
  status        text NOT NULL,
  reason        text,
  amount_cents  bigint,
  lithic        jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX disputes_holder ON disputes (cardholder_id, created_at DESC);

CREATE TABLE cases (
  id             text PRIMARY KEY,
  cardholder_id  text REFERENCES cardholders (id) ON DELETE CASCADE,
  transaction_id text REFERENCES transactions (id) ON DELETE SET NULL,
  kind           text,
  title          text NOT NULL,
  merchant       text,
  mcc            text,
  amount_cents   bigint,
  detailed_results text[] NOT NULL DEFAULT '{}',
  status         text NOT NULL DEFAULT 'OPEN',
  resolution     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cases_open ON cases (status, created_at DESC);
CREATE INDEX cases_transaction ON cases (transaction_id);

CREATE TABLE notifications (
  id            text PRIMARY KEY,
  cardholder_id text NOT NULL REFERENCES cardholders (id) ON DELETE CASCADE,
  title         text NOT NULL,
  body          text,
  kind          text NOT NULL DEFAULT 'info',
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_holder ON notifications (cardholder_id, created_at DESC);

CREATE TABLE email_outbox (
  id           text PRIMARY KEY,
  to_address   text NOT NULL,
  subject      text NOT NULL,
  body         text,
  kind         text,
  status       text NOT NULL DEFAULT 'QUEUED',
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  next_attempt_at timestamptz,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- The mailer claims due work with FOR UPDATE SKIP LOCKED over this index.
CREATE INDEX email_outbox_due ON email_outbox (status, next_attempt_at);

CREATE TABLE reports (
  id            text PRIMARY KEY,
  kind          text NOT NULL,
  connection_id text REFERENCES connections (id) ON DELETE SET NULL,
  credit_id     text REFERENCES credits (id) ON DELETE SET NULL,
  content       text NOT NULL,
  content_type  text NOT NULL DEFAULT 'application/xml',
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Bounded operational logs. asa_log was capped at 300 entries in the document; here it
-- is a real table and retention is a delete, not a slice.
CREATE TABLE asa_log (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL DEFAULT now(),
  cardholder_id text REFERENCES cardholders (id) ON DELETE SET NULL,
  merchant      text,
  mcc           text,
  amount_cents  bigint,
  decision      jsonb,
  response      jsonb,
  source        text
);

CREATE INDEX asa_log_at ON asa_log (at DESC);

CREATE TABLE webhooks (
  id         text PRIMARY KEY,
  kind       text,
  payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhooks_received ON webhooks (received_at DESC);

-- ---------------------------------------------------------------- ledger

-- Every movement of value is a balanced journal entry. Envelope balances are a
-- projection of these lines; the reconciliation job proves the projection.
CREATE TABLE ledger_accounts (
  id            text PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN (
                  'ENVELOPE',        -- restricted money owed to a cardholder
                  'FUNDING',         -- money received from a paying agency
                  'SETTLEMENT',      -- money paid away to merchants via Lithic
                  'CASH',            -- the cash part of a purchase or an ATM withdrawal
                  'RECALL',          -- money returned to a paying agency
                  'UNALLOCATED'      -- booked but not yet attributed to an envelope
                )),
  cardholder_id text REFERENCES cardholders (id) ON DELETE CASCADE,
  connection_id text REFERENCES connections (id) ON DELETE RESTRICT,
  envelope_id   text REFERENCES envelopes (id) ON DELETE CASCADE,
  currency      text NOT NULL DEFAULT 'EUR',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_accounts_envelope ON ledger_accounts (envelope_id);
CREATE INDEX ledger_accounts_holder ON ledger_accounts (cardholder_id);

CREATE TABLE journal_entries (
  id             bigserial PRIMARY KEY,
  -- Idempotency handle: replaying an ASA decision or a Lithic sync must not double-book.
  idempotency_key text NOT NULL,
  at             timestamptz NOT NULL DEFAULT now(),
  kind           text NOT NULL CHECK (kind IN (
                   'CREDIT', 'RECALL', 'AUTHORIZATION', 'SETTLEMENT',
                   'REVERSAL', 'REFUND', 'ALLOCATION', 'ADJUSTMENT'
                 )),
  source         text,
  transaction_id text REFERENCES transactions (id) ON DELETE SET NULL,
  credit_id      text REFERENCES credits (id) ON DELETE SET NULL,
  cardholder_id  text REFERENCES cardholders (id) ON DELETE SET NULL,
  memo           text,
  created_by     text
);

CREATE UNIQUE INDEX journal_entries_idempotency ON journal_entries (idempotency_key);
CREATE INDEX journal_entries_transaction ON journal_entries (transaction_id);
CREATE INDEX journal_entries_at ON journal_entries (at DESC);

CREATE TABLE journal_lines (
  id           bigserial PRIMARY KEY,
  entry_id     bigint NOT NULL REFERENCES journal_entries (id) ON DELETE CASCADE,
  account_id   text NOT NULL REFERENCES ledger_accounts (id) ON DELETE RESTRICT,
  direction    text NOT NULL CHECK (direction IN ('DR', 'CR')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  currency     text NOT NULL DEFAULT 'EUR'
);

CREATE INDEX journal_lines_entry ON journal_lines (entry_id);
CREATE INDEX journal_lines_account ON journal_lines (account_id);

-- An entry must balance. Deferred so a transaction can insert the entry and both of its
-- legs before the check runs, but it cannot commit unbalanced.
CREATE FUNCTION journal_entry_must_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target bigint := COALESCE(NEW.entry_id, OLD.entry_id);
  debits bigint;
  credits bigint;
BEGIN
  SELECT COALESCE(sum(amount_cents) FILTER (WHERE direction = 'DR'), 0),
         COALESCE(sum(amount_cents) FILTER (WHERE direction = 'CR'), 0)
    INTO debits, credits
    FROM journal_lines
   WHERE entry_id = target;

  -- An entry whose lines were all removed is gone with it; nothing to balance.
  IF debits = 0 AND credits = 0 THEN
    RETURN NULL;
  END IF;

  IF debits <> credits THEN
    RAISE EXCEPTION 'journal entry % does not balance: debits %, credits %',
      target, debits, credits
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_lines_balance
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION journal_entry_must_balance();

-- ---------------------------------------------------------------- controls

-- Tamper-evident audit: each row carries the hash of the previous row, so removing or
-- editing an entry breaks the chain and the verifier says where.
CREATE TABLE audit (
  id        bigserial PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  actor     text NOT NULL DEFAULT 'system',
  action    text NOT NULL,
  target    text,
  outcome   text NOT NULL DEFAULT 'ok',
  details   jsonb,
  ip        text,
  prev_hash text,
  hash      text NOT NULL
);

CREATE INDEX audit_at ON audit (at DESC);
CREATE INDEX audit_actor ON audit (actor, id DESC);
CREATE INDEX audit_action ON audit (action, id DESC);

-- Append-only. The application role may INSERT and SELECT; rewriting history has to be a
-- deliberate act by a superuser who first drops this trigger.
CREATE FUNCTION audit_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit is append-only (attempted %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_no_update
  BEFORE UPDATE OR DELETE ON audit
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();

-- Reconciliation against Lithic. A run records what was compared; a break is an
-- unexplained difference an operator must clear.
CREATE TABLE recon_runs (
  id          text PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'OK', 'BREAKS', 'FAILED')),
  checked     integer NOT NULL DEFAULT 0,
  break_count integer NOT NULL DEFAULT 0,
  summary     jsonb,
  error       text
);

CREATE INDEX recon_runs_started ON recon_runs (started_at DESC);

CREATE TABLE recon_breaks (
  id             text PRIMARY KEY,
  run_id         text NOT NULL REFERENCES recon_runs (id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN (
                   'ENVELOPE_BALANCE',      -- cached balance disagrees with the journal
                   'MISSING_IN_STIPEND',    -- Lithic has a transaction Stipend never saw
                   'MISSING_IN_LITHIC',     -- Stipend booked something Lithic does not have
                   'AMOUNT_MISMATCH',
                   'STATUS_MISMATCH',
                   'UNALLOCATED'
                 )),
  severity       text NOT NULL DEFAULT 'WARN' CHECK (severity IN ('INFO', 'WARN', 'CRITICAL')),
  cardholder_id  text REFERENCES cardholders (id) ON DELETE SET NULL,
  transaction_id text REFERENCES transactions (id) ON DELETE SET NULL,
  envelope_id    text REFERENCES envelopes (id) ON DELETE SET NULL,
  expected_cents bigint,
  actual_cents   bigint,
  detail         jsonb,
  status         text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RESOLVED', 'ACCEPTED')),
  resolved_by    text,
  resolved_at    timestamptz,
  resolution     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX recon_breaks_open ON recon_breaks (status, severity, created_at DESC);
CREATE INDEX recon_breaks_run ON recon_breaks (run_id);

-- Maker-checker. A sensitive write is parked here until a second operator approves it.
CREATE TABLE approvals (
  id           text PRIMARY KEY,
  action       text NOT NULL,
  target       text,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'EXPIRED', 'FAILED')),
  decided_by   text,
  decided_at   timestamptz,
  applied_at   timestamptz,
  note         text,
  error        text,
  expires_at   timestamptz,
  -- The maker may not be the checker. Enforced here so no route can forget it.
  CONSTRAINT approvals_four_eyes CHECK (decided_by IS NULL OR decided_by <> requested_by)
);

CREATE INDEX approvals_pending ON approvals (status, requested_at DESC);
