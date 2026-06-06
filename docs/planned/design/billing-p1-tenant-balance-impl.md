# P-1 Implementation RFC: Tenant Accounts, Unified Balance, Quota Windows

> Chinese version: [./billing-p1-tenant-balance-impl.zh-CN.md](./billing-p1-tenant-balance-impl.zh-CN.md)
> Note: the Chinese version is the source of truth. This English mirror is provided for accessibility.

Status: Draft (implementation-layer; will freeze field names / endpoints / table schema / error codes / metric IDs)
Branch: `repos/platform`
Companion reading:

- Protocol direction: `repos/protocol/docs/planned/design/billing-and-quota.md`
- Platform surface direction: `repos/platform/docs/planned/design/billing-design-rfc.md` (henceforth "platform direction RFC")
- Client-side consent: `repos/client/docs/planned/design/billing-caller-consent.md`

---

## 0. Up Front

This RFC is **not** a direction-setting RFC. It is the **P-1 stage implementation RFC**.

Its scope is narrow:

> Take the platform direction RFC §3 (tenant accounts + unified balance + quota windows) "direction" and freeze it into **field names / table schema / endpoints / error codes / metric IDs that engineering can implement directly**.

What this RFC adds on top of the direction RFC (without restating already-stated content):

| Dimension | What direction RFC said | What this RFC freezes on top |
| :--- | :--- | :--- |
| `credit_balance_cents` field | "must exist; the field is named that" | SQL type / NOT NULL / default / index |
| Unified-balance semantic | one tenant = one balance | a schema that physically forbids `caller_balance` / `responder_balance` split fields |
| Quota windows | at minimum daily / monthly / total | freeze `window_kind` enum + roll rule + `window_started_at` advancement algorithm |
| Atomicity | single SQL transaction | give the optimistic-lock `version` column + failure code + retry policy |
| Monitoring | imbalance ratio is a risk signal | freeze 4 metric IDs + alert thresholds (the numbers stay tunable; the IDs do not) |

Once this RFC lands, **these field names / endpoints / error codes / metric IDs are frozen**. Subsequent stages (P-2..P-4) may **add** fields, but cannot **rename / delete / re-semantic** any of them.

Out of scope for this RFC (still belong to later P stages):

- preflight quote (P-2)
- 5 auto-refund classes (P-2)
- trust_tier daemon (P-3)
- content review pipeline (P-3)
- dispute queue (P-4)
- take-rate accounting + webhook egress (P-4)
- fiat recharge / withdrawal (separate RFC)

---

## 1. Scope and relation to v0.1 platform-api

### 1.1 What P-1 ships

P-1's product semantics: "free-tier users **have a ledger to attach to** on the platform — they can read the balance, see history, and be protected by quota caps."

Physical artifacts this RFC commits the platform repo to:

- 4 PostgreSQL tables (§3)
- 3 new endpoints (§4): `GET /v1/tenants/{tenant_id}/balance`, `GET /v1/tenants/{tenant_id}/ledger`, `POST /v1/tenants/{tenant_id}/recharge`
- 1 quota windows lazy-reset algorithm (§5)
- 6 error codes (§6, aligned with platform direction RFC Appendix A.6 + additions)
- 4 monitoring metrics (§7)
- 1 invariant self-check daemon (§8)

P-1 **does not** introduce:

- Any caller / responder behavioural change (balance is a read-only window in P-1; per-call billing arrives in P-2)
- Any modification to v0.1 platform-api fields already frozen

### 1.2 v0.1 compatibility stance

All artifacts live under a fresh `/v1/` URL namespace; **v0.1 platform-api is left untouched**.

Concretely:

- v0.1 frozen endpoints (caller/responder token issuance, hotline catalog, result envelope, etc.) stay binary-compatible.
- All P-1 endpoints sit under `/v1/tenants/...`; existing v0.1 endpoints never gain a `tenant_id`-required path.
- v0.1 token claims gain no new fields (quote / billing claims belong to P-2).
- After P-1, old v0.1 clients keep working the caller / responder flow — they just cannot see their own balance and cannot be quota-blocked (`hard_block_on_exceed` defaults to `false` in P-1; see §5.4).

### 1.3 P-1 release gates

P-1 is "done" when all five hold:

1. Migrations for the four tables are live and ALTER-compat-reviewed.
2. The three new endpoints pass end-to-end contract tests in staging.
3. The quota lazy-reset algorithm survives chaos tests without losing a roll (see §9.3).
4. The four monitoring metrics live on a dashboard; alert thresholds run in production-shadow mode for 7 days without false positives.
5. The invariant self-check daemon runs 24h on staging without firing.

---

## 2. Data model overview

P-1 introduces these physical objects:

```
tenant_balance              ← one row per tenant; current spendable + pending balance
   │
   ├─ tenant_quota_window   ← one row per (tenant, window_kind)
   │
   └─ tenant_balance_ledger ← append-only audit log of balance moves

tenant_recharge_request     ← finite-state record per recharge request (P-1: server-side worker only)
```

`tenant_balance` is the OLTP root; `tenant_balance_ledger` is the OLAP / audit source. All balance reads go through `tenant_balance`; all balance moves write **both** tables (`tenant_balance` + `tenant_balance_ledger`) inside the **same transaction**.

---

## 3. Schema (DDL drafts; this RFC freezes field names + types + NOT NULL)

### 3.1 `tenant_balance`

```sql
CREATE TABLE tenant_balance (
  tenant_id              VARCHAR(64)  PRIMARY KEY,

  -- spendable balance: caller side debits + responder side credits live here
  credit_balance_cents   BIGINT       NOT NULL DEFAULT 0,

  -- earnings from untrusted-tier hotlines that haven't yet completed
  -- the §7.4 (platform RFC) settlement delay; visible but unspendable
  pending_credit_cents   BIGINT       NOT NULL DEFAULT 0,

  -- the platform's accepted point unit; one of `PTS` (default) or future
  -- ISO 4217 codes once fiat is allowed (NOT in P-1)
  currency               VARCHAR(8)   NOT NULL DEFAULT 'PTS',

  -- optimistic-lock cursor, bumped on every UPDATE
  version                BIGINT       NOT NULL DEFAULT 0,

  created_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT credit_balance_nonneg CHECK (credit_balance_cents >= 0),
  CONSTRAINT pending_credit_nonneg CHECK (pending_credit_cents >= 0)
);
```

Frozen points:

- `tenant_id` is a string PK; **no** UUID/INT auto-id. Sync with the v0.1 caller / responder token's tenant binding logic.
- `credit_balance_cents` / `pending_credit_cents` are `BIGINT` (max 2^63-1 cents ≈ 9.2 × 10^16 PTS), no overflow risk from long-run accumulation.
- `currency` allows future fiat codes; **P-1 only accepts `PTS`** (see §6 `ERR_BILLING_CURRENCY_UNSUPPORTED`).
- `version` is required; §5.2 uses it for single-transaction CAS.
- The two CHECK constraints are the physical guarantee of protocol direction §5.4 "no half-refunds" — any transaction that would push the balance negative fails at the SQL layer.

### 3.2 `tenant_quota_window`

```sql
CREATE TYPE quota_window_kind AS ENUM ('daily', 'monthly', 'total');

CREATE TABLE tenant_quota_window (
  tenant_id                     VARCHAR(64)        NOT NULL,
  window_kind                   quota_window_kind  NOT NULL,

  -- left-closed boundary of the current window in UTC; rolled forward
  -- by the §5 lazy-reset algorithm. For window_kind='total' this is the
  -- account creation timestamp and never moves.
  window_started_at             TIMESTAMPTZ        NOT NULL,

  -- the per-window cap. NULL = no cap on this window for this tenant
  max_amount_cents              BIGINT             NULL,

  -- caller-side spend INSIDE the current window
  used_as_caller_cents          BIGINT             NOT NULL DEFAULT 0,

  -- responder-side earnings INSIDE the current window
  earned_as_responder_cents     BIGINT             NOT NULL DEFAULT 0,

  -- when true: hitting the cap rejects new tokens with ERR_QUOTA_EXCEEDED
  -- when false: warn-event only, continue accepting tokens
  hard_block_on_exceed          BOOLEAN            NOT NULL DEFAULT FALSE,

  created_at                    TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ        NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, window_kind),
  CONSTRAINT used_as_caller_nonneg      CHECK (used_as_caller_cents >= 0),
  CONSTRAINT earned_as_responder_nonneg CHECK (earned_as_responder_cents >= 0)
);
```

Frozen points:

- `quota_window_kind` enum has **exactly** `daily | monthly | total`. This RFC forbids `weekly` / `quarterly` etc. (governance value low, schema cost high).
- `(tenant_id, window_kind)` is the composite PK; no surrogate id.
- Caller-side and responder-side **must** book separately — this physically realises platform direction RFC §3.2.
- `max_amount_cents` allows NULL (= no cap on that window for that tenant); reserved for ops whitelisting.
- `hard_block_on_exceed` defaults to `FALSE` (rationale in §5.4).

### 3.3 `tenant_balance_ledger`

```sql
CREATE TYPE ledger_kind AS ENUM (
  'hold',                     -- caller token issuance pre-debit (P-2 writes)
  'hold_release',             -- caller hold released back without debit (P-2)
  'debit',                    -- caller actual settlement at result-landing (P-2)
  'refund',                   -- one of the 5 protocol auto-refund classes (P-2)
  'credit',                   -- responder earnings posted (P-2)
  'pending_credit_release',   -- untrusted-tier earnings released after T days (P-3)
  'pending_credit_revoke',    -- untrusted-tier earnings revoked on freeze (P-3)
  'recharge',                 -- platform recharge worker writes here (P-1 yes)
  'admin_adjustment'          -- platform ops manual adjustment (audit-only) (P-1)
);

CREATE TYPE ledger_direction AS ENUM (
  'caller_spend',
  'responder_earn',
  'system'                    -- recharge / admin_adjustment use this
);

CREATE TABLE tenant_balance_ledger (
  ledger_id                ULID         PRIMARY KEY,
  tenant_id                VARCHAR(64)  NOT NULL,
  kind                     ledger_kind  NOT NULL,
  direction                ledger_direction NOT NULL,

  -- positive = balance increases; negative = balance decreases
  amount_cents             BIGINT       NOT NULL,

  -- references the upstream protocol object that caused this ledger row,
  -- if any. NULL for recharge / admin_adjustment.
  request_id               VARCHAR(64)  NULL,
  quote_id                 VARCHAR(64)  NULL,

  -- snapshot of balance before/after this row was written; lets readers
  -- reconstruct the ledger without re-executing arithmetic
  prev_balance_cents       BIGINT       NOT NULL,
  new_balance_cents        BIGINT       NOT NULL,

  -- snapshot of pending_credit before/after; same semantics
  prev_pending_credit_cents BIGINT      NOT NULL,
  new_pending_credit_cents  BIGINT      NOT NULL,

  recorded_at              TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX tenant_balance_ledger_by_tenant
  ON tenant_balance_ledger (tenant_id, recorded_at DESC, ledger_id DESC);

CREATE INDEX tenant_balance_ledger_by_request
  ON tenant_balance_ledger (request_id) WHERE request_id IS NOT NULL;
```

Frozen points:

- `ledger_id` is a ULID (26-char sortable string): time-ordered cursor pagination + cross-DC unique.
- `kind` enum already includes values P-2 / P-3 / P-4 stages will write (`hold` / `debit` / `refund` / `credit` / `pending_credit_*`). This RFC only **adds** enum values within P-1; subsequent stages may not redefine these values' semantics.
- `direction` is locked at three values; P-2 cannot append.
- `prev_balance_cents` / `new_balance_cents` are **redundant** but let auditors reconstruct any-time balances without replaying the whole table — a hard requirement for compliance and reconciliation.
- The primary index on `(tenant_id, recorded_at DESC, ledger_id DESC)` is exactly the §4.2 ledger endpoint's pagination selectivity.

### 3.4 `tenant_recharge_request`

```sql
CREATE TYPE recharge_state AS ENUM (
  'submitted',     -- worker accepted the request, hasn't acted yet
  'authorized',    -- payment provider returned auth (out of P-1 scope)
  'captured',      -- balance has been credited; ledger row exists
  'failed',        -- worker gave up; balance untouched
  'refunded'       -- ops or worker reversed a captured row (audit only)
);

CREATE TABLE tenant_recharge_request (
  recharge_id           VARCHAR(64)     PRIMARY KEY,
  tenant_id             VARCHAR(64)     NOT NULL,
  amount_cents          BIGINT          NOT NULL,
  currency              VARCHAR(8)      NOT NULL DEFAULT 'PTS',
  state                 recharge_state  NOT NULL DEFAULT 'submitted',

  -- references the ledger row that posted the credit, when state='captured'.
  -- NULL until capture.
  captured_ledger_id    ULID            NULL,

  -- free-form provider hint (NULL in P-1; useful for future fiat integration)
  provider              VARCHAR(32)     NULL,
  external_reference    VARCHAR(256)    NULL,

  created_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),

  CONSTRAINT amount_positive CHECK (amount_cents > 0)
);
```

Frozen points:

- `recharge_state` is exactly 5 values; `captured` is the only state that touches the balance.
- `captured_ledger_id` must point to `tenant_balance_ledger.ledger_id` (DB-side soft FK; application enforces). This is the physical embodiment of "every recharge has an audit trail".
- In P-1, `provider` / `external_reference` may both be NULL; they are reserved for future fiat integration but do not freeze semantics here.

---

## 4. Endpoint contracts (v1 namespace, additive)

### 4.1 `GET /v1/tenants/{tenant_id}/balance`

Returns the tenant's current balance + the state of all quota windows.

**Auth**: a v0.1 caller token **or** responder token bound to that `tenant_id`, **or** an ops-admin service token.

**Response 200**:

```json
{
  "tenant_id": "user_acme",
  "credit_balance_cents": 50000,
  "pending_credit_cents": 800,
  "currency": "PTS",
  "windows": [
    {
      "window_kind": "daily",
      "window_started_at": "2026-05-06T00:00:00Z",
      "max_amount_cents": 100000,
      "used_as_caller_cents": 25000,
      "earned_as_responder_cents": 4000,
      "hard_block_on_exceed": false
    },
    {
      "window_kind": "monthly",
      "window_started_at": "2026-05-01T00:00:00Z",
      "max_amount_cents": 2000000,
      "used_as_caller_cents": 350000,
      "earned_as_responder_cents": 60000,
      "hard_block_on_exceed": false
    },
    {
      "window_kind": "total",
      "window_started_at": "2026-03-12T08:11:00Z",
      "max_amount_cents": null,
      "used_as_caller_cents": 1850000,
      "earned_as_responder_cents": 320000,
      "hard_block_on_exceed": false
    }
  ],
  "rate_limit_per_second": 2,
  "credit_mode": "prepaid"
}
```

Frozen points:

- Top-level fields exactly mirror platform direction RFC Appendix A.3.
- `windows[]` **must** include all three of `daily | monthly | total` (even when `max_amount_cents` is null).
- `rate_limit_per_second` comes from platform direction RFC §3.2; P-1 fixes the default at `2/s` (an application-config concern, not a schema column).
- `credit_mode` literal value in P-1 is the single allowed string `"prepaid"`; reserved for future `"postpaid_invoice"` but P-1 does not implement it.

**Response 404**: tenant does not exist.

### 4.2 `GET /v1/tenants/{tenant_id}/ledger?cursor=&limit=&kind=`

Retrieve balance-move history in reverse-chronological order with keyset pagination.

**Query parameters**:

- `cursor` (optional): the previous response's `next_cursor`; omit on first call.
- `limit` (optional): 1..200, default 50.
- `kind` (optional, repeatable): only return rows of the given `ledger_kind` (e.g. `?kind=debit&kind=refund`).
- `since` (optional): ISO 8601; only return rows with `recorded_at >= since`.

**Response 200**:

```json
{
  "items": [
    {
      "ledger_id": "01HF8C8AEXAMPLE1",
      "kind": "debit",
      "direction": "caller_spend",
      "amount_cents": -50,
      "request_id": "req_01HFA1ZZZ",
      "quote_id": "q_01HF7XYZ",
      "prev_balance_cents": 50050,
      "new_balance_cents": 50000,
      "prev_pending_credit_cents": 800,
      "new_pending_credit_cents": 800,
      "recorded_at": "2026-05-06T10:31:00Z"
    }
  ],
  "next_cursor": "MDFISkM5Q08xMjM0NQ==",
  "has_more": true
}
```

Frozen points:

- Pagination is keyset (not offset). `next_cursor` is a base64-encoded `(recorded_at, ledger_id)` pair; opaque to clients.
- `amount_cents` is always signed (caller_spend negative, responder_earn positive, system depends on `kind`).
- Internal "reason" fields are not returned (privacy / risk-rule leak).

**Response 404**: tenant does not exist.

### 4.3 `POST /v1/tenants/{tenant_id}/recharge`

**Auth**: only platform internal worker / ops-admin service tokens; caller / responder tokens are **rejected**.

**Request body**:

```json
{
  "recharge_id": "rch_01HF...",
  "amount_cents": 10000,
  "currency": "PTS",
  "provider": null,
  "external_reference": null,
  "idempotency_key": "rch_01HF..."
}
```

**Response 201**:

```json
{
  "recharge_id": "rch_01HF...",
  "state": "captured",
  "credit_balance_cents_after": 60000,
  "captured_ledger_id": "01HF8DCAPTURE111"
}
```

Frozen points:

- `recharge_id` must be supplied by the caller (the server does not generate it); the server only does ULID/UUID-shape sanity check.
- `idempotency_key` in P-1 is required to equal `recharge_id` — leaves room for a richer idempotency model later, but kept simple here.
- A second submission of the same `recharge_id` returns `200` (not `201`) with the previous `captured_ledger_id`; the balance is **not** double-credited.
- Any failure (amount<=0 / currency unsupported / tenant missing / DB write error) → no ledger row, no `tenant_recharge_request` row.
- This endpoint integrates with **no** fiat payment provider; in P-1 "recharge" semantics is "ops pre-deposits points into the system". A fiat bridge will be a separate RFC layered on top.

---

## 5. Quota window roll & deduction algorithms

### 5.1 Roll anchors (UTC-locked)

| `window_kind` | Roll moment (UTC) |
| :--- | :--- |
| `daily`   | every day at 00:00:00 |
| `monthly` | the 1st of every month at 00:00:00 |
| `total`   | never |

P-1 does not support ops-defined "company fiscal year roll" or "per-caller anniversary roll"; if a future stage needs it, layer a new `window_kind` enum value on top — do not change the existing three.

### 5.2 Lazy-reset algorithm

On every quota check (triggered by `POST /v1/calls/consent`, the §4.3 recharge, `GET /v1/tenants/{tenant_id}/balance`):

```python
def ensure_window_fresh(tx, tenant_id: str, kind: WindowKind, now_utc: datetime):
    row = tx.select_for_update(
        "SELECT window_started_at, version FROM tenant_quota_window "
        "WHERE tenant_id = $1 AND window_kind = $2",
        tenant_id, kind,
    )
    expected_started_at = boundary_for(kind, now_utc)
    if row.window_started_at < expected_started_at:
        tx.execute(
            "UPDATE tenant_quota_window SET "
            "  window_started_at = $1, "
            "  used_as_caller_cents = 0, "
            "  earned_as_responder_cents = 0, "
            "  updated_at = now() "
            "WHERE tenant_id = $2 AND window_kind = $3",
            expected_started_at, tenant_id, kind,
        )
        tx.emit_event("platform.quota_window.rolled", {
            "tenant_id": tenant_id,
            "window_kind": kind,
            "rolled_to": expected_started_at,
        })
```

Frozen points:

- A roll does **not** write `tenant_balance_ledger` — quota window resets are not balance moves, just metering windows.
- The roll emits `platform.quota_window.rolled` for monitoring.
- The roll uses `SELECT FOR UPDATE` for concurrency safety: one (tenant, kind) pair rolls at most once across concurrent requests.
- `boundary_for(kind, now_utc)` is pure: daily → same-day UTC 00:00; monthly → 1st of the same month UTC 00:00; total → the caller's account creation timestamp (written at migration time).

### 5.3 Standard form of a balance-move transaction (P-2 will use it; P-1 recharge already does)

```python
def apply_balance_delta(tx, tenant_id, delta_cents, kind, direction,
                        request_id=None, quote_id=None,
                        pending_delta_cents=0):
    # 1. lock the balance row + bump version (optimistic-lock CAS)
    row = tx.select_for_update(
        "SELECT credit_balance_cents, pending_credit_cents, version "
        "FROM tenant_balance WHERE tenant_id = $1",
        tenant_id,
    )
    new_balance = row.credit_balance_cents + delta_cents
    new_pending = row.pending_credit_cents + pending_delta_cents
    if new_balance < 0 or new_pending < 0:
        raise BillingInternalError("would_break_invariant")
    tx.execute(
        "UPDATE tenant_balance SET "
        "  credit_balance_cents = $1, "
        "  pending_credit_cents = $2, "
        "  version = version + 1, "
        "  updated_at = now() "
        "WHERE tenant_id = $3 AND version = $4",
        new_balance, new_pending, tenant_id, row.version,
    )
    # 2. roll quota windows lazy-style + accumulate the delta on each window
    for window_kind in ("daily", "monthly", "total"):
        ensure_window_fresh(tx, tenant_id, window_kind, now_utc=now())
        accumulate_window(tx, tenant_id, window_kind, delta_cents, direction)
    # 3. append to the ledger
    tx.insert_ledger(
        ledger_id=ulid(),
        tenant_id=tenant_id,
        kind=kind,
        direction=direction,
        amount_cents=delta_cents,
        request_id=request_id,
        quote_id=quote_id,
        prev_balance_cents=row.credit_balance_cents,
        new_balance_cents=new_balance,
        prev_pending_credit_cents=row.pending_credit_cents,
        new_pending_credit_cents=new_pending,
        recorded_at=now(),
    )
```

Frozen points:

- The `version` CAS is P-1's only concurrency strategy; no application-layer pessimistic row locks.
- Balance update + quota window accumulation + ledger insert **must** sit in one SQL transaction; any failure → full rollback → throw `ERR_BILLING_INTERNAL`.
- A missing ledger row is forbidden — that's the central invariant of §8's self-check daemon.

### 5.4 The `hard_block_on_exceed` default compromise

Platform direction RFC §3.2 says "platform default = prepaid + hard_block on". This RFC **temporarily flips `hard_block_on_exceed` default to `false`**, scoped only to P-1.

Reasons:

- preflight quote arrives in P-2. If P-1 already had hard_block on, calls before P-2 ship would still get blocked despite no debit happening — counter-intuitive product behaviour.
- With the default off in P-1, quota mostly serves "usage observation", not "user blocking".
- After P-2 ships, a migration script will flip every existing tenant's `hard_block_on_exceed` to `true` to match the platform direction RFC default; that migration is frozen in the P-2 implementation RFC.

This compromise is a **deliberate** divergence from the direction RFC and is registered explicitly so future engineers don't quietly revert it.

---

## 6. Error codes

The error code set frozen by P-1 (aligned with platform direction RFC Appendix A.6, plus additions):

| Error code | HTTP | Retryable | Trigger | Introduced |
| :--- | ---: | :--- | :--- | :--- |
| `ERR_TENANT_NOT_FOUND` | 404 | false | `tenant_id` does not exist | P-1 new |
| `ERR_BILLING_CURRENCY_UNSUPPORTED` | 400 | false | request submitted with a currency other than `PTS` | platform direction A.6 |
| `ERR_QUOTA_EXCEEDED` | 429 | true (after window roll) | `hard_block_on_exceed=true` and the window is past its cap | platform direction A.6 |
| `ERR_BILLING_INTERNAL` | 500 | true | invariant violation inside a transaction or repeated CAS failure | platform direction A.6 |
| `ERR_RECHARGE_DUPLICATE_KEY` | 409 | false | same `recharge_id` resubmitted with mismatched amount/currency | P-1 new |
| `ERR_RECHARGE_NOT_AUTHORIZED` | 403 | false | caller / responder token tried to call the recharge endpoint | P-1 new |

Frozen points:

- All error code strings are uppercase ASCII + underscore; new P-2 / P-3 / P-4 codes must follow the same shape.
- HTTP status and retryable are part of the contract; clients decide auto-retry from `retryable`.

---

## 7. Monitoring metrics (metric IDs frozen)

| Metric ID | Type | Meaning | Default alert (draft) |
| :--- | :--- | :--- | :--- |
| `platform.tenant_balance.invariant_violation` | counter | Times §8's self-check daemon detected balance < 0 / pending < 0 / ledger discontinuity | > 0 / 5min (P0) |
| `platform.tenant_balance.cas_retry_p99` | histogram | CAS retry count per `apply_balance_delta` P99 | > 5 / 5min (concurrency anomaly hint) |
| `platform.quota_window.rolled` | counter | Quota window rolls; tagged by `window_kind` | per-daily-window roll lag > 60s triggers (impl) |
| `platform.tenant_balance.imbalance_ratio` | gauge | Per-tenant `used_as_caller / earned_as_responder` ratio distribution | per-tenant > 100x for 24h → manual risk queue |

Frozen points:

- The four metric ID strings are frozen by this RFC. Subsequent stages may **add** new metrics (e.g. `platform.preflight_quote.expired` from P-2) but may not rename these four.
- The threshold numbers are **not** frozen (ops SLA); P-2 may tune them.
- Metrics must be exposed prometheus-compatibly; alerts are configured in the ops-console back-office dashboard (a separate RFC).

---

## 8. Invariant self-check daemon

P-1 GA also requires shipping a **read-only** daemon that runs every `T_check` (default 60s):

1. Full scan of `tenant_balance`; assert `credit_balance_cents >= 0` and `pending_credit_cents >= 0`.
2. Sample `tenant_balance_ledger` (last 100 rows per tenant); assert:
   - row N's `prev_balance_cents` == row N-1's `new_balance_cents` (continuity).
   - row N's `new_balance_cents - prev_balance_cents` == `amount_cents`, and `direction` matches `kind` (per §5.3).
3. Per-tenant recompute `tenant_balance.credit_balance_cents` = last ledger's `new_balance_cents`; assert match.
4. On any failed assertion → bump `platform.tenant_balance.invariant_violation` + emit a structured alert event `platform.invariant_violation.detail` (fields: tenant_id, ledger_id_window, assertion_name, sampled_at).

Frozen points:

- The daemon **does not** repair anomalies — it detects + alerts only; repairs go through ops with the ops-admin token's `admin_adjustment` ledger kind (§3.3).
- The daemon must be a read-only path; any write path is an incident.
- The daemon must run 24h on staging without an invariant violation before going to production — this is the §1.3 release gate.

---

## 9. Edge cases and known compromises

### 9.1 When `tenant_balance` rows are created

- The first time a `tenant_id` appears: a downstream hook of v0.1 caller / responder registration. This RFC freezes the hook as: after registration succeeds, a platform back-end worker immediately does `INSERT INTO tenant_balance (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING` plus three `INSERT`s into `tenant_quota_window`.
- No lazy-create is allowed — that would introduce a concurrency race on the first balance move.

### 9.2 `total` window's `window_started_at`

`total`'s `window_started_at` is written at the row's first creation, equal to the tenant's first registration time, and never changes after. If ops want to "reset the total window", they must explicitly walk through `admin_adjustment` ledger + a direct UPDATE to the quota_window row; this RFC does not introduce an endpoint for that.

### 9.3 Chaos assumptions for the lazy-reset

P-1 release gate (§1.3 #3) requires chaos coverage for:

- Many concurrent requests crossing the roll boundary at once → §5.2's `SELECT FOR UPDATE` guarantees a single roll.
- DB failover with 5-minute lag → lazy-reset takes time from `now()`, never from a stale-node cache.
- System time jumps backward (NTP drift) → `boundary_for(kind, now_utc)` is monotonically conditional (`window_started_at < expected_started_at`); a backward jump cannot trigger a spurious roll.

### 9.4 Contract boundary with v0.1 caller / responder tokens

In P-1:

- v0.1 token claims do not change.
- The platform back-end worker (not the client) is responsible for tying caller-token `tenant_id` to `tenant_balance.tenant_id`; this mapping is platform-internal and not exposed at the endpoint level.
- Caller tokens do not need any `billing.*` claims. The first shipped P-1 API/read-model slice is admin-only (`/v1/admin/billing/*`) so operators can create tenants, inspect balances, record manual recharges, and inspect ledger rows. Caller / responder self-service balance views remain a later P-1/P-2 surface and cannot be used to spend through the token yet.

### 9.5 Implementation stance for `currency`

- The DB column allows arbitrary 8-character ASCII; the application layer in P-1 enforces the whitelist `{'PTS'}`.
- If a future fiat phase introduces `'USD'`, the schema does not move — the application whitelist just expands.
- Multi-currency exchange semantics, FX pipelines, multi-currency composite balances etc. are **not** assumed here; they live in a separate RFC.

---

## 10. Test & release matrix

### 10.1 Unit test coverage (P-1 release gate #4)

At minimum:

- `apply_balance_delta` happy path / invariant-trigger path / CAS-retry path
- `ensure_window_fresh` daily / monthly roll / `total` no-roll
- `recharge` idempotency: same `recharge_id` second call returns last result
- `recharge` rejects caller / responder tokens; accepts ops-admin tokens
- `GET /v1/admin/billing/tenants/{tenant_id}/ledger` keyset pagination correctness + `kind` filter

### 10.2 Contract tests (end-to-end)

- Real PostgreSQL; run §1.3 #2's admin-only `GET balance` / `GET ledger` / `POST recharge` trio.
- Verify the schema fully matches §4 (response field set, type, nullability).
- Validate `prev/new_balance_cents` continuity across multiple recharges.

### 10.3 Rollout strategy

- Shadow mode: staging routes all caller / responder calls through "pretend" quota checks (metrics only, no blocking) for 7 days.
- Canary: production picks 5% tenants with `hard_block_on_exceed=true` (manual flag, not a default); watch §7's four metrics for 24h with no invariant violation.
- General availability: default stays `hard_block_on_exceed=false` (§5.4); ops flip it per tenant on demand.

### 10.4 Rollback path

- Migration rollback: this RFC's four tables are dropped; no impact to v0.1 surface.
- Application rollback: pulling the P-1 admin endpoints `GET balance` / `GET ledger` / `POST recharge` does not affect caller / responder traffic (no v0.1 caller depends on them).

---

## 11. Roadmap

P-1 internal milestones (four):

| Milestone | Theme | Unlocks |
| :--- | :--- | :--- |
| M1.1 | DB schema migration + unit tests | tables exist; `apply_balance_delta` works |
| M1.2 | admin-only `/v1/admin/billing/*` tenant, balance, recharge, and ledger read model | operators can inspect and adjust billing state without exposing client-facing spend semantics |
| M1.3 | quota lazy-reset + `ERR_QUOTA_EXCEEDED` | business layer ready to lean on quota (even if default off) |
| M1.4 | monitoring metrics + invariant self-check daemon | the last gate before production |

Each milestone requires:

- The previous milestone observed for 7 days on staging.
- Unit + contract test coverage matches §10.1 / §10.2.
- Monitoring alerts run in silent mode for some time without false positives.

---

## Appendix A: Field correspondence to platform direction RFC Appendix A

The fields / endpoint paths frozen here vs. the direction RFC's Appendix A. Frozen = this column is the source of truth from now on.

| Direction RFC (Appendix A) | This RFC (frozen) | Status |
| :--- | :--- | :--- |
| `tenant_id` | `tenant_balance.tenant_id` | match |
| `credit_balance_cents` | `tenant_balance.credit_balance_cents` | match |
| `pending_credit_cents` | `tenant_balance.pending_credit_cents` | match |
| `currency` | `tenant_balance.currency` | match; P-1 application whitelist `'PTS'` |
| `windows[].window_kind` | `tenant_quota_window.window_kind` | match; enum locked at daily/monthly/total |
| `windows[].max_amount_cents` | `tenant_quota_window.max_amount_cents` | match; P-1 allows NULL |
| `windows[].used_as_caller_cents` | `tenant_quota_window.used_as_caller_cents` | match |
| `windows[].earned_as_responder_cents` | `tenant_quota_window.earned_as_responder_cents` | match |
| `rate_limit_per_second` | (application config; not in this RFC's schema) | match; included in endpoint response |
| `credit_mode` | (application enum; only `prepaid`) | match; P-1's only allowed value |
| `hard_block_on_exceed` | `tenant_quota_window.hard_block_on_exceed` | match; **default flipped to `false` in P-1, registered in §5.4** |

---

## Appendix B: References

- Protocol direction: `repos/protocol/docs/planned/design/billing-and-quota.md`
- Platform surface direction: `repos/platform/docs/planned/design/billing-design-rfc.md`
- v0.1 platform API: `repos/platform/docs/current/spec/platform-api-v0.1.md`
- v0.1 defaults: `repos/platform/docs/current/spec/defaults-v0.1.md`
- Client-side consent: `repos/client/docs/planned/design/billing-caller-consent.md`
