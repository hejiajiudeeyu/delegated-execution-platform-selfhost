CREATE TYPE quota_window_kind AS ENUM ('daily', 'monthly', 'total');

CREATE TYPE ledger_kind AS ENUM (
  'hold',
  'hold_release',
  'debit',
  'refund',
  'credit',
  'pending_credit_release',
  'pending_credit_revoke',
  'recharge',
  'admin_adjustment'
);

CREATE TYPE ledger_direction AS ENUM (
  'caller_spend',
  'responder_earn',
  'system'
);

CREATE TYPE recharge_state AS ENUM (
  'submitted',
  'authorized',
  'captured',
  'failed',
  'refunded'
);

CREATE TABLE tenant_balance (
  tenant_id              VARCHAR(64)  PRIMARY KEY,
  credit_balance_cents   BIGINT       NOT NULL DEFAULT 0,
  pending_credit_cents   BIGINT       NOT NULL DEFAULT 0,
  currency               VARCHAR(8)   NOT NULL DEFAULT 'PTS',
  version                BIGINT       NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT credit_balance_nonneg CHECK (credit_balance_cents >= 0),
  CONSTRAINT pending_credit_nonneg CHECK (pending_credit_cents >= 0)
);

CREATE TABLE tenant_quota_window (
  tenant_id                     VARCHAR(64)        NOT NULL,
  window_kind                   quota_window_kind  NOT NULL,
  window_started_at             TIMESTAMPTZ        NOT NULL,
  max_amount_cents              BIGINT             NULL,
  used_as_caller_cents          BIGINT             NOT NULL DEFAULT 0,
  earned_as_responder_cents     BIGINT             NOT NULL DEFAULT 0,
  hard_block_on_exceed          BOOLEAN            NOT NULL DEFAULT FALSE,
  created_at                    TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ        NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, window_kind),
  CONSTRAINT used_as_caller_nonneg CHECK (used_as_caller_cents >= 0),
  CONSTRAINT earned_as_responder_nonneg CHECK (earned_as_responder_cents >= 0)
);

CREATE TABLE tenant_balance_ledger (
  ledger_id                  VARCHAR(26)        PRIMARY KEY,
  tenant_id                  VARCHAR(64)        NOT NULL,
  kind                       ledger_kind        NOT NULL,
  direction                  ledger_direction   NOT NULL,
  amount_cents               BIGINT             NOT NULL,
  request_id                 VARCHAR(64)        NULL,
  quote_id                   VARCHAR(64)        NULL,
  prev_balance_cents         BIGINT             NOT NULL,
  new_balance_cents          BIGINT             NOT NULL,
  prev_pending_credit_cents  BIGINT             NOT NULL,
  new_pending_credit_cents   BIGINT             NOT NULL,
  recorded_at                TIMESTAMPTZ        NOT NULL DEFAULT now()
);

CREATE INDEX tenant_balance_ledger_by_tenant
  ON tenant_balance_ledger (tenant_id, recorded_at DESC, ledger_id DESC);

CREATE INDEX tenant_balance_ledger_by_request
  ON tenant_balance_ledger (request_id) WHERE request_id IS NOT NULL;

CREATE TABLE tenant_recharge_request (
  recharge_id           VARCHAR(64)     PRIMARY KEY,
  tenant_id             VARCHAR(64)     NOT NULL,
  amount_cents          BIGINT          NOT NULL,
  currency              VARCHAR(8)      NOT NULL DEFAULT 'PTS',
  state                 recharge_state  NOT NULL DEFAULT 'submitted',
  captured_ledger_id    VARCHAR(26)     NULL,
  provider              VARCHAR(32)     NULL,
  external_reference    VARCHAR(256)    NULL,
  created_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT amount_positive CHECK (amount_cents > 0)
);
