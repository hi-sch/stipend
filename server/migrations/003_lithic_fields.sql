-- Columns the Lithic integration writes, found by reading server/lithicService.js in full
-- rather than inferring the shape from the state document.

-- The account holder is a separate Lithic object from the account: issueCard creates it,
-- accountHolder() refreshes KYC against it, and the account_holder.updated event arrives
-- carrying only that token, so it has to be findable by it.
ALTER TABLE cardholders
  ADD COLUMN lithic_holder uuid,
  -- Physical card lifecycle stamps: orderedAt, shippingMethod, reissuedAt, renewedAt.
  ADD COLUMN physical jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Sent to Lithic for KYC_BYO. Demo data has no real date of birth and the service falls
  -- back to a placeholder, so this stays nullable rather than inventing one.
  ADD COLUMN dob text;

CREATE INDEX cardholders_lithic_holder ON cardholders (lithic_holder) WHERE lithic_holder IS NOT NULL;

-- Disputes carry more than the first migration allowed for. A dispute filed with Lithic is
-- identified by its token in every webhook that follows, so that is the lookup key; a
-- dispute filed while Lithic is unconfigured has none and stays local.
ALTER TABLE disputes
  ADD COLUMN lithic_token uuid,
  ADD COLUMN merchant jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN note text,
  ADD COLUMN resolution_reason text;

CREATE UNIQUE INDEX disputes_lithic_token ON disputes (lithic_token) WHERE lithic_token IS NOT NULL;

-- One open dispute per transaction. fileDispute() checked this by scanning the document;
-- as a partial unique index the database enforces it, including against two operators
-- filing at the same moment.
CREATE UNIQUE INDEX disputes_one_open_per_transaction
  ON disputes (transaction_id)
  WHERE status <> ALL ('{WITHDRAWN,CASE_CLOSED}');
