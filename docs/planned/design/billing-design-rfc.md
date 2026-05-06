# Billing Design — Platform Surface RFC

> Chinese version: [./billing-design-rfc.zh-CN.md](./billing-design-rfc.zh-CN.md)
> Note: the Chinese version is the source of truth. This English mirror is provided for accessibility.

Status: Direction-setting (no field name / endpoint path / numeric value frozen)
Branch: `repos/platform`
Companion reading:

- Protocol direction: `repos/protocol/docs/planned/design/billing-and-quota.md`
- Client-side consent: `repos/client/docs/planned/design/billing-caller-consent.md` (T6-3)
- Super-repo integration: the billing-rfc bundle bumped after `changes/CHG-2026-022.yaml` (T6-4)

---

## 0. Up Front

This RFC is **not** a "billing feature spec". It answers a narrower but more pressing question:

> The protocol direction is set (`billing-and-quota.md`). On that direction, what surface does **the platform repo** own — and what does it categorically refuse to take on?

It does not restate the protocol direction. The "why market-demand allocation", "why three pricing models", "why we don't separate subjective malice from model-uncontrolled output" arguments belong in the protocol RFC; do not look for them here.

This RFC also **freezes nothing**. Field names, endpoint paths, retry policies, threshold numbers, sampling rates all live in Appendix A as drafts.

---

## 1. Scope

### 1.1 Platform's role on the billing path

Under the protocol direction the platform is a **trusted clearing-and-operations layer** that owns three things:

1. Tenant accounts, unified balance, quota windows (caller and responder share one balance).
2. The "machine-decidable" rules the protocol direction names — preflight quote, pre-debit, settlement, auto-refund, trust_tier promotion/demotion, content review.
3. Acting as the bookkeeping middle between caller and responder, but **not** as the subjective arbiter, content creator, or traffic distributor.

The platform is the OPC network's "clearing-house + risk + admission". The marketplace lives on brand-site; creator tooling lives in `repos/client`.

### 1.2 Relation to the protocol RFC

| Protocol direction | What this RFC commits the platform to |
| :--- | :--- |
| §2 market-demand allocation | No "cost pass-through" fields; never expose responder-internal cost |
| §3 three pricing models | Platform passes `pricing_hint` through verbatim; no "which model is more reasonable" judgment |
| §4.2 hotline self-reports + cap | Platform enforces `max_total_cents`; **does not** time, **does not** monitor internals |
| §5.1 pre-debit + single settlement | Platform implements the two-stage (hold at token issuance / debit at result-landing) sequence |
| §5.2 auto-refund | Platform implements 5 machine-decidable refund triggers (unverified / timeout / failed / frozen / content-rejected) |
| §5.3 subjective dispute | Platform accepts disputes only for sub-verified hotlines; verified hotlines refuse one-sided complaint |
| §6 zero-trust hotline | Platform owns trust_tier daemon, dual-call sampling, drift detection, content review pipeline |
| §6.7 do not separate subjective malice | Platform only checks output rule triggers; never asks responders to prove subjective benevolence |
| Appendix A.1.4 unified balance | Tenant table = one `credit_balance_cents` + bidirectional use_history |

**Reverse boundary**: anything the protocol direction did not say, this RFC does not invent (no pass-through, no half-refunds, no subjective-arbitration dashboards).

### 1.3 Non-goals

- No UI design here (caller consent UX is the client RFC; back-office UI is a later ops RFC).
- No specific take rate / refund latency / promotion threshold (commercial / SLA decisions).
- No fiat integration (the points system phase 1 does not allow withdrawal — see §10.4).
- No "weekly/monthly escrow + staged acceptance" semantics from human outsourcing markets.
- No "half-refund / partial-refund / proportional refund".
- No caller-facing "internal cost panel" — callers see only outward commitments.

---

## 2. Platform-layer responsibility list

The protocol direction's machine-decidable responsibilities, mapped onto this repo, become these eight surfaces. Sections 3–10 walk through them:

1. Tenant accounts and unified balance (§3)
2. Preflight quote and consent verification (§4)
3. Debit timing and atomicity (§5)
4. Auto-refund engine (§6)
5. Trust-tier promotion/demotion daemon (§7)
6. Content review pipeline (§8)
7. Dispute queue (§9)
8. Where the take rate lives + billing event egress (§10)

---

## 3. Tenant accounts and unified balance

### 3.1 One tenant_id = one balance

Continuing protocol Appendix A.1.4:

- A single `tenant_id` shares one `credit_balance_cents`.
- Caller-side spend draws from the same pool that responder-side calls credit.
- No split between caller and responder accounts; no split per hotline.

The platform exposes a single `GET /v1/tenants/{tenant_id}/balance` resource whose response includes `used_as_caller_cents` and `earned_as_responder_cents` — purely informational, **not** load-bearing for the unified-balance semantics.

### 3.2 Quota windows

Quota windows live in the platform, **not** the protocol:

- At minimum, daily / monthly / total windows coexist.
- Windows record caller-side spend and responder-side earnings **separately** (so a single big responder gig cannot exhaust the caller-side daily cap as a side effect).
- Exceeding quota does not flat-deny; behaviour is governed by `hard_block_on_exceed`: true → reject with `ERR_QUOTA_EXCEEDED`; false → warn-event + continue.
- Platform default = prepaid + hard_block on.

### 3.3 Atomicity of balance moves

Any balance change must satisfy:

- Caller hold / debit / refund and responder credit move in **one SQL transaction**; no "deducted from caller but not credited to responder" intermediate state is allowed.
- Failure rolls back wholesale — no half-write on retry; raise `ERR_BILLING_INTERNAL`.
- Platform does not expose a "transaction id" to caller / responder (transaction boundaries are an internal implementation concern).

### 3.4 Network effect from unified balance

Unified balance is a hard requirement from the protocol direction; the platform treats it as product infrastructure:

- Lowest friction when OPCs call each other (A pays B with credit; B's incoming call from C tops up the balance same day, instead of "earned points but waiting for settlement").
- No need for ops to publish "can the credit a caller earned be spent by a responder" runbooks — naturally fused.
- `used_as_caller_cents` / `earned_as_responder_cents` become risk signals (extreme imbalance ⇒ one-sided drain or account brokering).

---

## 4. Preflight quote and consent verification

### 4.1 Preflight is a platform API, not a protocol API

Callers must be able to obtain a **quote** before invoking a hotline — that is the preflight quote. It must be a platform-level API rather than a protocol-level one because:

- A quote is a function of the hotline's current state × the tenant's current state (trust_tier / quota / balance / current pricing).
- The protocol layer only stipulates that callers **must** consent to `max_charge_cents`; it does not specify how the quote is computed.
- Letting the platform compute the quote allows policy (free trials, new-user discounts, tier discounts) to ship without touching the protocol skeleton.

### 4.2 Preflight output contract

- `pricing_model` (one of fixed_price / base_plus_duration / base_plus_tokens — see protocol §3).
- `max_charge_cents` (the upper bound the caller agrees to).
- `currency` (default `PTS` / Call Credit).
- `expires_at` (quote validity; suggested initial value: 5 minutes).
- `trust_tier_at_quote` (the hotline's trust tier as of quote generation; freezing the hotline afterwards does not invalidate quotes already issued before `expires_at`).
- `responder_self_report_required` (does the responder need to report unit count in `result.usage`?).
- `disclaimer_required` (must the hotline emit a §6.5.3 disclaimer?).

Not exposed:

- Responder-internal cost / margin.
- Platform take-rate (folded into the total; never surfaced).
- The caller's "remaining promo uses" (that is an app-level concern, not a quote-level one).

### 4.3 Consent verification

When issuing the call token the platform must verify:

- `claims.billing.max_charge_cents` ≥ `quote.max_charge_cents` → otherwise `ERR_BILLING_MAX_CHARGE_TOO_LOW`.
- `claims.pricing_model` matches `quote.pricing_model` → otherwise `ERR_BILLING_PRICING_MODEL_MISMATCH`.
- `claims.currency` is on the platform allow list → otherwise `ERR_BILLING_CURRENCY_UNSUPPORTED`.
- caller-consented amount ≤ trust_tier cap (Appendix A.3) → otherwise `ERR_TRUST_TIER_LIMIT_EXCEEDED`.
- Caller balance covers the hold → otherwise `ERR_PREPAID_BALANCE_INSUFFICIENT`.
- Caller window quota covers the hold → otherwise `ERR_QUOTA_EXCEEDED`.

Verification failures all reject at token issuance; "issue first, fail at execution" is forbidden.

### 4.4 No auto top-up

The platform does not "auto top up the caller's wallet from a stored credit card when balance runs out".

- On prepaid mode, balance exhaustion → no new tokens; existing tokens may run to completion.
- Recharge entry is a separate RFC (§10.4); phase 1 supports point purchase only.

---

## 5. Debit timing and atomicity

### 5.1 Two stages

Continuing protocol §5.1:

| Stage | Trigger | Action |
| :--- | :--- | :--- |
| Hold | token issued | tenant balance -= max_charge_cents; emit `caller.request.billing_held` |
| Debit | result lands SUCCEEDED | actual ≤ max → refund the diff; actual > max → cap at max (responder eats the rest); emit `caller.request.billing_capped` |

### 5.2 Where actual amount is computed

- fixed_price: actual = hotline `pricing_hint.unit_price_cents`. Responder self-report is irrelevant.
- base_plus_duration / base_plus_tokens: actual = base + responder-reported variable count × unit price, capped at `max_total_cents`.
- The platform does not audit the truthfulness of the variable count itself — but feeds it into §7 drift detection (an anomalous distribution across multiple callers ⇒ drift signal).

### 5.3 Responder credit timing

Responder credit posts in the same transaction as the caller debit, but in two ledger states:

- responder trust_tier ≥ trusted: credit posts to balance immediately.
- responder trust_tier = untrusted: credit posts to a `pending_credit` sub-account; settlement is delayed (see §7.4).

Either way, the caller's debit completes immediately — never delayed.

### 5.4 Where the take rate lives

Take rate = actual debit − responder credit. That delta:

- Settles in the same transaction as `result.SUCCEEDED`.
- Appears in **no** caller / responder API field.
- Accumulates only in an internal `tenant.platform_revenue` account.
- Specific percentage is an ops-config concern (not frozen by either the protocol or this RFC).

---

## 6. Auto-refund engine

### 6.1 Five machine-decidable full refunds

Lifted directly from protocol §5.2:

| Trigger | Detection point | Event |
| :--- | :--- | :--- |
| UNVERIFIED | platform-side signature / schema / price-consistency check | `caller.request.refunded_unverified` |
| TIMED_OUT | `hard_timeout` watchdog daemon | `caller.request.refunded_timeout` |
| FAILED-non-retryable | result lands FAILED with `error.retryable=false` | `caller.request.refunded_failed` |
| HOTLINE_FROZEN | hotline is frozen while the caller's `prepared` is still alive | `caller.request.refunded_hotline_frozen` |
| CONTENT_REJECTED | content review rejects before `result` is shown | `caller.request.refunded_content_rejected` |

### 6.2 Refund semantics

- **Full, automatic, no caller appeal needed** — these five are protocol-level mandates; the platform may not introduce a "judgment threshold".
- Refund = move the held amount from platform escrow back into the caller's `credit_balance_cents`.
- The refund transaction must complete within ≤ 1 ledger tick of the triggering event landing; otherwise raise `platform.refund_lag`.
- No half-refunds — protocol direction explicitly forbids.

### 6.3 Refund's effect on responder

- UNVERIFIED / CONTENT_REJECTED: responder credit = 0; no trust-tier earnings.
- TIMED_OUT / FAILED-non-retryable: same.
- HOTLINE_FROZEN: callers refunded in full, but legitimate results delivered before the freeze still post normally — the freeze blocks new tokens, not retroactive ones.

---

## 7. Trust-tier promotion/demotion daemon

### 7.1 Locked by the protocol

Per protocol §6 / Appendix A.6:

- Four tiers: untrusted / trusted / verified / frozen.
- `frozen` is **not** on the same promotion/demotion line as the other three — it is the incident path, triggered by admin or §8 content review.
- Promotion and demotion are machine-driven; no rating-buy.

### 7.2 What the daemon does

- Listen to 5 ledger event classes in real time (`pricing_drift` / `sla_drift` / `dual_call_mismatch` / `content_rejected` / `dispute_resolved`).
- Accumulate windowed indicators per protocol Appendix A.6 (concrete numbers frozen at impl-RFC time).
- On crossing → emit `hotline.tier_changed` → influence subsequent quotes' caps (§4.2 `trust_tier_at_quote`).

### 7.3 Anti-fraud (dual-call sampling)

- The platform performs an anonymous dual call every N calls (suggested N=200): same input, same hotline, compare whether two results agree within schema bounds.
- Disagreement → emit `dual_call_mismatch` → accumulate → eventually trigger trust-tier demotion.
- Sampling cost is borne by the platform, not the caller; covered by the take rate.

### 7.4 Settlement delay (`pending_credit`)

- Untrusted-tier hotline credits go into `pending_credit` for T days (suggested T=7) before transferring to the main balance.
- If the hotline transitions to frozen within those T days, `pending_credit` is forfeited.
- After T days with the hotline still at ≥ untrusted → released to main balance.
- Trusted / verified tiers are not subject to `pending_credit`.

---

## 8. Content review pipeline (§6.5 risk-line B landing)

### 8.1 Review goals

Per protocol §6.5: platform content review is a trust-tier promotion gate AND a refund trigger — not a result-visibility switch.

In practice:

- Review passes → result lands SUCCEEDED → caller sees output.
- Review rejects → result still lands SUCCEEDED but the platform masks output, fires CONTENT_REJECTED refund (§6.1), and accumulates a trust-tier demotion signal.

### 8.2 Tiered review strategy

The platform does not subject every call to strong review. Per the hotline's `disclaimer.risk_level` (Appendix A.8 of the protocol RFC):

- `info` (default): no review; format-validate only on caller's call record.
- `low`: sampled review (suggested 1–5%).
- `medium`: 100% asynchronous review (does not block the caller from receiving the result, but triggers later mask + refund + demotion).
- `high`: 100% synchronous review (blocks before `result.SUCCEEDED` lands).

`high` is the only tier that "blocks" callers; the others all let the result reach the caller first and post-process.

### 8.3 Review worker integration

Platform ships 5 rule engines (not delegating everything to LLM review, to avoid false positives on legitimate hotlines):

| Rule | Detects |
| :--- | :--- |
| prompt_injection | output contains obvious jailbreak / role-override templates |
| executable_payload | output contains executable shell command / SQL injection / XSS payload |
| pii_leak | output contains PII the hotline did not declare in its output schema |
| disallowed_category | output falls inside `disclaimer.disallowed_outputs[]` |
| schema_violation_post_check | passed schema but second-pass semantic check fails (e.g. number out of range) |

Each rule firing → emit `content_review.rejected` → walk §6.1 CONTENT_REJECTED refund.

### 8.4 Caller-side experience

- Most hotlines stay info / low → callers basically never feel the review.
- medium / high hotlines → `quote.disclaimer_required = true`; the caller-consent flow (client RFC) must show the disclaimer.
- A CONTENT_REJECTED result → the console shows "review failed, auto-refunded" in red; never shows the masked content (avoiding review-circumvention).

### 8.5 Out of scope

- No hotline-defined LLM reviewer (avoid responder self-reviewing-self-trading).
- Rule details are not published for hotline debugging (avoid targeted bypass); rejections only return the category, not the matching sub-rule.
- The platform does not review caller-supplied input (input safety is the caller's responsibility).

---

## 9. Dispute queue (the minority path)

### 9.1 Acceptance

Per protocol §5.3:

- Caller-side "result is SUCCEEDED but I'm subjectively dissatisfied".
- **Only** for untrusted / trusted tier hotlines.
- Verified-tier hotlines reject one-sided complaint (response: `ERR_DISPUTE_NOT_ACCEPTED_FOR_TIER`).

### 9.2 Flow

- Caller submits → enters the platform-ops queue.
- Default SLA: respond within 14 business days (specific SLA is operations, not frozen here).
- Three discrete outcomes only: keep the original debit / full refund (same semantics as §6.2) / mark hotline for admin review.
- No "half-refund / 30% withhold" — every dispute is a discrete decision.

### 9.3 Anti-abuse

- A caller's monthly dispute submission rate exceeding a threshold → automatic 30-day appeal suspension.
- Dispute win rate (caller-side) is recorded only as an internal risk signal — never published.
- One dispute per request — callers cannot bulk-replay a hotline and then bulk-dispute.

### 9.4 Out of scope

- No feedback / rating mechanism on dispute — that is a future evaluation-RFC.
- Dispute queue state is not visible to responders (only the terminal `dispute.resolved` event reaches them).
- No "responder counter-dispute".

---

## 10. Where the take rate lives + billing event egress

### 10.1 Take rate location

See §5.4: take rate = actual debit − responder credit.

- Never exposed to caller / responder fields.
- Configured per ops policy / hotline-by-hotline negotiation / global fallback.
- The internal `platform_revenue` account closes daily and emits a platform-only `platform.daily_revenue` event.

### 10.2 What the take rate funds

- Dual-call sampling cost (§7.3).
- Content review worker cost (§8.3).
- Auto-refund pool (§6 refunds draw from here).
- Long term: ops / customer support / legal.

Caller / responder shall not need to know how the take rate is allocated.

### 10.3 Billing event egress

The platform offers one webhook channel (POST to a per-tenant configured endpoint) carrying:

- `caller.request.billing_held / billing_capped / refunded_*`
- `responder.request.credited / pending_credit_released / pending_credit_revoked`
- `hotline.tier_changed / pricing_drift / sla_drift`

Excluded:

- Platform take-rate amount.
- Other tenants' events (isolation).
- Content review rule details (§8.5).

Webhook fails retry × 3 + persistent dead-letter; callers / responders must not silently miss a settlement event.

### 10.4 No fiat (yet)

Phase 1:

- `currency` defaults to `PTS` (points).
- The recharge entry may attach to fiat purchase of points (handled by ops in the platform's jurisdiction); points themselves **are not redeemable for fiat**.
- This stance also lands in brand-site copy and the client RFC (caller consent flow must say "non-fiat, no withdrawal").

Phase 2 (no committed timeline):

- Fiat withdrawal would arrive together with ISO 4217 currency codes + KYC / AML requirements; that is a separate RFC.

---

## 11. Out of scope for this RFC

These exist but are not refined here:

- Take-rate percentage (commercial decision).
- Concrete `pending_credit` T value (ops SLA).
- Concrete preflight `expires_at` seconds (impl).
- Webhook schema / retry policy concretes (impl).
- Specific content-review rule field schemas (§8.5 explains why these stay private).
- Fiat integration + KYC (separate RFC).
- Platform back-office UI (separate ops-console design).
- "OPC chain billing" (chained take rates when OPC A invokes OPC B that invokes OPC C — protocol direction has not landed; the platform does not invent it).
- "Multi-responder split" (a single request fanning out to multiple responders — protocol direction has not landed).

---

## 12. Roadmap

The platform RFC is staged into 4 milestones; each has a corresponding future impl-RFC (not frozen here):

| Stage | Theme | Unlocks |
| :--- | :--- | :--- |
| P-1 | tenant accounts + unified balance + quota windows | "free-tier users finally have a ledger to attach to" |
| P-2 | preflight + consent verify + two-stage debit + 5 auto-refund | "calling really debits points" becomes true |
| P-3 | trust_tier daemon + anti-fraud sampling + content review (info/low/medium) | "submitting a hotline is no longer cost-free" |
| P-4 | dispute queue + content review high tier + take-rate ledger + webhook egress | "platform ops have an evidentiary trail" |

Each stage requires:

- Preceding stage shipped, monitoring stable.
- Impl-RFC reviewed across protocol + platform + client.
- Caller-side UI updated in lockstep (disclaimer rendering, refund toasts).

---

## Appendix A: Surface drafts (not frozen)

### A.1 `GET /v1/preflight`

Request:

```json
{
  "hotline_id": "foxlab.text.classifier.v1",
  "caller_tenant_id": "user_acme",
  "input_summary_hint": "10 KB transcript"
}
```

Response:

```json
{
  "quote_id": "q_01HF7XYZ",
  "pricing_model": "fixed_price",
  "max_charge_cents": 50,
  "currency": "PTS",
  "expires_at": "2026-05-06T10:30:00Z",
  "trust_tier_at_quote": "trusted",
  "responder_self_report_required": false,
  "disclaimer_required": false
}
```

### A.2 `POST /v1/calls/consent`

Caller invokes after accepting the quote. The platform verifies per §4.3 and writes token claims.

```json
{
  "quote_id": "q_01HF7XYZ",
  "billing": {
    "pricing_model": "fixed_price",
    "max_charge_cents": 50,
    "currency": "PTS",
    "acknowledged": true
  }
}
```

### A.3 `GET /v1/tenants/{tenant_id}/balance`

```json
{
  "tenant_id": "user_acme",
  "credit_balance_cents": 50000,
  "currency": "PTS",
  "windows": [
    { "window_kind": "daily", "max_amount_cents": 100000, "used_as_caller_cents": 25000, "earned_as_responder_cents": 4000 },
    { "window_kind": "monthly", "max_amount_cents": 2000000, "used_as_caller_cents": 350000, "earned_as_responder_cents": 60000 }
  ],
  "rate_limit_per_second": 2,
  "credit_mode": "prepaid",
  "hard_block_on_exceed": true,
  "pending_credit_cents": 800
}
```

`pending_credit_cents` is the §7.4 untrusted-tier delayed amount; visible but unspendable.

### A.4 `POST /v1/disputes`

```json
{
  "request_id": "req_01HFA1ZZZ",
  "reason_category": "incorrect_output | did_not_follow_input | broken_response_format | other",
  "free_text": "..."
}
```

The platform returns a `dispute_id`; subsequent state transitions reach the caller via webhook.

### A.5 Webhook event envelope

```json
{
  "event_id": "evt_01HFB2AAA",
  "event_name": "caller.request.refunded_unverified",
  "tenant_id": "user_acme",
  "occurred_at": "2026-05-06T10:31:00Z",
  "payload": {
    "request_id": "req_01HFA1ZZZ",
    "amount_cents": 50,
    "currency": "PTS",
    "reason_code": "ERR_UNVERIFIED_RESULT"
  },
  "signature": "..."
}
```

`signature` is the platform's signature over `event_id || tenant_id || occurred_at || payload`. Caller / responder must verify it before acking.

### A.6 Error codes (additive, aligned with protocol Appendix A.2.1)

On top of protocol Appendix A.2.1's 10 codes, the platform layer **adds**:

| Error code | HTTP | Retryable | Trigger |
| :--- | ---: | :--- | :--- |
| `ERR_BILLING_INTERNAL` | 500 | true | platform transaction rolled back, debit/credit failed |
| `ERR_DISPUTE_NOT_ACCEPTED_FOR_TIER` | 403 | false | dispute submitted but hotline already verified |
| `ERR_DISPUTE_RATE_LIMITED` | 429 | true (after window rolls over) | caller appeal rights suspended |
| `ERR_QUOTE_EXPIRED` | 410 | true (after preflight again) | `quote_id` past `expires_at` |
| `ERR_QUOTE_NOT_FOUND` | 404 | false | `quote_id` unknown or already used |
| `ERR_PENDING_CREDIT_INSUFFICIENT` | 409 | false | responder tries to spend unreleased `pending_credit` |

---

## Appendix B: References

- Protocol direction: `repos/protocol/docs/planned/design/billing-and-quota.md`
- Protocol Appendix A.1.4 unified balance: ibid. §A.1.4
- Protocol Appendix A.6 promotion thresholds: ibid. §A.6
- Protocol Appendix A.8 disclaimer: ibid. §A.8
- v0.1 platform API: `repos/platform/docs/current/spec/platform-api-v0.1.md`
- v0.1 defaults: `repos/platform/docs/current/spec/defaults-v0.1.md`
