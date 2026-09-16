-- Two tables the first migration missed, both found by reading what the application
-- actually persists rather than what the state document appeared to hold.

-- responders.js keeps a rolling log of 3DS and tokenization decisions. It lived in the
-- state document as `responderLog`, capped at 300 entries by slicing an array; here the
-- cap is a retention policy rather than a side effect of writing.
CREATE TABLE responder_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL,
  token      text,
  decision   text,
  reason     text,
  amount_cents bigint,
  request    jsonb,
  response   jsonb
);

CREATE INDEX responder_log_at ON responder_log (at DESC);
CREATE INDEX responder_log_kind ON responder_log (kind, at DESC);

-- Lithic sends a webhook-id header and retries on failure. app.js treated a repeated id as
-- a duplicate and skipped re-handling the event; that check was a scan over the last 300
-- webhooks in the document. As a unique index it is both cheaper and actually reliable:
-- two replicas receiving the same retry cannot now both decide they are the first.
ALTER TABLE webhooks
  ADD COLUMN message_id text,
  ADD COLUMN event_type text,
  ADD COLUMN verified boolean NOT NULL DEFAULT false,
  ADD COLUMN duplicate boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX webhooks_message_id ON webhooks (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX webhooks_event_type ON webhooks (event_type, received_at DESC);
