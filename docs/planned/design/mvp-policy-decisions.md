# Private Capability Network MVP Policy Decisions (A-05 / A-06 / A-07)

> Chinese version: [mvp-policy-decisions.zh-CN.md](mvp-policy-decisions.zh-CN.md)
> Note: the Chinese document is the source of truth.

- Status: **owner approved** (2026-07-31); the numbers are an MVP starting point and may move with dogfood data
- Source PRD: `CALL ANYTHING next-stage product requirements v1.0` (strategy-frozen 2026-07-16)
- Approval record: workspace `.trellis/tasks/07-17-call-anything-private-capability-network-mvp/decisions.md`
- Milestones: A-05/A-06 → M3; A-07 → M1 (metadata retention) and M3 (content retention)
- Protocol-side semantics (the four axes, legal transitions, financial matrix) live in the protocol repository's `docs/planned/design/mvp-architecture-decisions.md`. This document fixes only **this platform's policy values and enforcement rules**.

## General principle: snapshot policy into the Call

Every policy value is **snapshotted into the Call at creation** and is immune to later network configuration changes. Acceptance windows and retention periods are promises to the Caller: changing configuration afterwards must not retroactively change the rules of a transaction that already happened, and a dispute must be able to answer "what were the rules at the time?".

---

## A-05 Acceptance window defaults

**Decision**: the acceptance window is set per **HotlineVersion / tier**, constrained by network minimum and maximum, and snapshotted into the Call.

| Level | Value |
|---|---|
| Network default | **72 hours** |
| Network minimum | **24 hours** |
| Network maximum | **7 days** |
| Quick tier | 24 hours |
| Standard tier | 72 hours |
| Deep tier | 7 days |

**Clock rules**:

- Start = **Delivery Integrity becomes `verified`**, not the moment a Responder submits bytes.
- A full window **restarts** after the single revision.
- No action within the window → `auto_accepted` → settle (FR-044).
- A dispute pauses the window, moves Settlement to `blocked`, and waits for the Operator (FR-045/FR-053).

**Rationale**: deeper tiers need more Caller verification time, and Deep additionally ships human-reviewed material. A single uniform window would either rush Deep acceptance or leave Quick funds idle. The bounds stop one Hotline from setting an extreme value (a one-hour window is effectively forced auto-acceptance).

**To be validated by dogfood**: 72 hours is an estimate. M5 should record the actual distribution of time-to-first-acceptance and adjust.

---

## A-06 Revision economics

**Decision**: the fixed price **includes one in-scope revision at no extra charge**; the original hold is reused with no second hold; out-of-scope work requires a new Call.

**Rules**:

| Case | Handling |
|---|---|
| in-scope revision (contract shortfall) | free once; the original hold stays `held`; a new window starts after redelivery |
| second revision request | refused — after the one revision only acceptance or dispute remain |
| out-of-scope request | refused with a pointer to a new Call; **no silent scope expansion, no automatic tier upgrade** |
| still unsatisfied after revision | the dispute path, where the Operator judges contract fulfilment |

**Test to apply**: a revision may only repair a **fulfilment shortfall under the original Brief** (FR-043). "I changed my mind" or "please also add another route" is not a revision, it is a new Call. In disputes the Operator judges only whether the prior service contract was fulfilled, never the absolute truth of an open question (FR-046).

**Rationale**: one free revision keeps the large majority of quality disagreements out of the dispute process at predictable cost, while unlimited free revisions would turn a fixed price into unbounded labour. Banning silent upgrades enforces the PRD's explicit "no silent paid upsell".

---

## A-07 Data retention

**Decision**: **retention is set per category**, snapshotted into the Call; tombstones survive byte deletion; dispute and legal hold override deletion.

| Category | Default retention | Note |
|---|---|---|
| Content and artifacts (input/output/evidence bytes) | **30 days** | most sensitive, shortest |
| Raw execution logs | **14 days** | troubleshooting value decays fastest |
| Metadata and events (Call, transitions, artifact descriptors) | **180 days** | supports metrics and reconciliation; carries no content |
| Audit and ledger | **365 days** | money and content-access records, longest |

**Rules**:

- Deleting bytes leaves a **tombstone** (descriptor + checksum + deletion time and reason) so historical Calls stay explainable and the deletion itself is auditable (in the spirit of FR-063).
- **Deletion pauses during a dispute or legal hold** and resumes after resolution.
- Retention is **network-configurable**, but the value snapshotted into the Call wins — shortening configuration later does not retroactively delete data that was promised.
- **Content is not used for training by default** (PRD 11.5); deletion, export and Operator content access are all traceable.

**Rationale**: a single retention period forces a choice between keeping sensitive content too long and dropping metadata too early to reconcile. Per-category retention lets content disappear quickly while the books stay long. The platform has no retention or deletion mechanism today; this is a capability to build from zero.

---

## Gap against today (input for M1/M3 decomposition)

| Today | Gap |
|---|---|
| settlement follows execution completion, no acceptance gate | needs the A-05 window, auto-accept timer and dispute freeze |
| no concept of a revision | needs the A-06 single revision round, scope validation and window restart |
| no retention or deletion at all; request snapshots never evicted | needs A-07 per-category retention, tombstones and hold override, done together with the request-storage rework |
| no backup or restore tooling | a retention policy needs a verifiable deletion path; backups come before deletion |

## Not frozen here

Platform commission: **no commission this stage** (the full amount credits the responder side). Commission is a later standalone feature; its ledger form, together with the `responder_earn` entry, is decided when M3 designs settlement semantics — the old Marketplace blueprint is explicitly not carried over.
