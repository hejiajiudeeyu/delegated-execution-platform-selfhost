# P-1 实施层 RFC：tenant 账户、合并余额、quota 窗口

> 英文版：[./billing-p1-tenant-balance-impl.md](./billing-p1-tenant-balance-impl.md)
> 说明：中文文档为准。

状态：草案（实施层，会冻结字段名 / endpoint / 表结构 / 错误码 / 监控指标）
分支：`repos/platform`
配套阅读：
- 协议方向：`repos/protocol/docs/planned/design/billing-and-quota.zh-CN.md`
- 平台 surface 方向：`repos/platform/docs/planned/design/billing-design-rfc.zh-CN.md`（以下简称『platform 方向 RFC』）
- 客户端同意流：`repos/client/docs/planned/design/billing-caller-consent.zh-CN.md`

---

## 0. 写在前面

这份 RFC **不是**方向定位 RFC，而是 **P-1 阶段的实施层 RFC**。

它要做的事很窄：

> 把 platform 方向 RFC §3（tenant 账户 + 合并余额 + quota 窗口）的『方向』，冻结为**可以直接进入工程实现**的字段名 / 表结构 / endpoint / 错误码 / 监控指标。

定位差异（不重复方向 RFC 已经讲过的事，但要承认它们）：

| 维度 | 方向 RFC 说了什么 | 本 RFC 在此之上做什么 |
| :--- | :--- | :--- |
| `credit_balance_cents` 字段 | 必须存在，字段名是它 | 冻结 SQL 类型 / NOT NULL / 默认值 / 索引 |
| 合并余额语义 | 一个 tenant 一份余额 | 给出 schema 不允许出现 caller_balance / responder_balance 拆字段的物理保证 |
| quota 窗口 | 至少 daily / monthly / total | 冻结 `window_kind` 枚举值 + 翻页规则 + `window_started_at` 推进算法 |
| 原子性 | 单 SQL 事务 | 给出 optimistic lock 的 `version` 列 + 失败码 + 重试策略 |
| 监控 | 不平衡比率是风控信号 | 冻结 4 条指标名 + 告警阈值（草案数值仍可调，但指标 ID 冻结）|

本 RFC 一旦合入，**这些字段名 / endpoint / 错误码 / 监控指标 ID 就是冻结的**——后续阶段（P-2..P-4）可以**追加**新字段，但不可以**改名 / 删除 / 改语义**。

不在本 RFC 范围（仍属 P-1 之后阶段）：

- preflight quote（P-2）
- 5 类 auto-refund（P-2）
- trust_tier daemon（P-3）
- 内容审查管线（P-3）
- dispute 队列（P-4）
- 抽佣账户与 webhook 出口（P-4）
- 法币充值 / 提现（独立 RFC）

---

## 1. 范围与与 v0.1 platform-api 的关系

### 1.1 P-1 要交付的东西

P-1 的产品语义是：『free-tier 用户在平台上**有账可挂**——可以查余额、可以看历史明细、可以受到 quota 上限保护』。

本 RFC 在 platform 仓里要落到的物理产物：

- 4 张 PostgreSQL 表（§3）
- 3 个新 endpoint（§4）：`GET /v1/tenants/{tenant_id}/balance`、`GET /v1/tenants/{tenant_id}/ledger`、`POST /v1/tenants/{tenant_id}/recharge`
- 1 个内部 quota windows lazy-reset 算法（§5）
- 6 个错误码（§6，与 platform 方向 RFC 附录 A.6 对齐 + 追加）
- 4 条监控指标（§7）
- 1 个不可变性自检 daemon（§8）

P-1 **不引入**：

- 任何 caller-side / responder-side 的功能行为变化（balance 在 P-1 里是只读窗口；调用扣费是 P-2 的事）
- 任何对 v0.1 platform-api 已冻结字段的修改

### 1.2 与 v0.1 platform-api 的兼容立场

本 RFC 的所有产物都活在 **新的 `/v1/` URL namespace** 下；**v0.1 platform-api 完全不动**。

具体含义：

- v0.1 已冻结的 endpoint（caller/responder token 签发、hotline catalog、result envelope 等）保持二进制兼容。
- P-1 endpoint 都加在 `/v1/tenants/...` 之下；现有 v0.1 endpoint 不会出现 `tenant_id` 必填路径。
- v0.1 token claims 不新增字段（quote / billing claims 是 P-2 的事，不属于 P-1）。
- P-1 上线后，老 v0.1 client 仍能正常完成 caller / responder 流程——只是看不到自己的余额，也不会被 quota block（hard_block_on_exceed 默认值在 P-1 阶段保守地设为 `false`，见 §5.4）。

### 1.3 P-1 的可上线判定

满足下面 5 条 P-1 才能宣告完成：

1. 4 张表的 migration 已上线，已通过 `ALTER` 兼容性 review。
2. 3 个新 endpoint 在 staging 通过端到端契约测试。
3. quota lazy-reset 算法在 chaos 测试下不丢翻页（参考 §9.3）。
4. 4 条监控指标已上 dashboard，告警阈值在 production-shadow 模式下跑过 7 天没误报。
5. 不可变性自检 daemon 在 staging 跑过 24h 没报 invariant violation。

---

## 2. 数据模型概览

P-1 引入下面的物理对象：

```
tenant_balance        ← 每个 tenant 一行的当前可用余额（含 pending）
   │
   ├─ tenant_quota_window   ← 每个 tenant × 每个 window_kind 一行
   │
   └─ tenant_balance_ledger ← append-only 余额变动审计表
   
tenant_recharge_request   ← 充值请求的有限状态机记录（P-1 阶段仅服务端 worker 可写）
```

`tenant_balance` 是 OLTP 主对象；`tenant_balance_ledger` 是 OLAP / 审计来源。所有余额读取走 `tenant_balance`，所有余额变动写**两张表**（`tenant_balance` + `tenant_balance_ledger`）在**同一事务**内完成。

---

## 3. 表结构（DDL 草案，本 RFC 冻结字段名 + 类型 + NOT NULL）

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

冻结点：

- `tenant_id` 是字符串 PK，**不**用 UUID/INT 自增；与 v0.1 caller/responder token 的 tenant 绑定逻辑同步。
- `credit_balance_cents` / `pending_credit_cents` 是 `BIGINT`（最大 2^63-1 cents ≈ 9.2 × 10^16 PTS），不会因为单租户长期累积溢出。
- `currency` 列允许未来 phase 接入 ISO 4217；**P-1 阶段平台只接受 `PTS`**（见 §6 错误码 `ERR_BILLING_CURRENCY_UNSUPPORTED`）。
- `version` 列必须存在；本 RFC §5.2 用它实现单事务原子写。
- 两条 CHECK 约束就是协议方向 §5.4『不引入半退款』的物理保证——任何会让余额变负的事务必然在 SQL 层失败。

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

冻结点：

- `quota_window_kind` 枚举有且仅有 `daily | monthly | total` 三个值。本 RFC 不允许追加 `weekly` / `quarterly` 等档位（多窗口治理价值低，schema 复杂度高）。
- `(tenant_id, window_kind)` 是复合 PK；不引入 surrogate id。
- caller-side 与 responder-side 必须**分别**记账——这是 platform 方向 RFC §3.2 的硬要求物理化。
- `max_amount_cents` 允许 NULL（= 该 window 对该 tenant 不设上限）；这给运营做白名单留接口。
- `hard_block_on_exceed` 默认 `FALSE`（理由见 §5.4）。

### 3.3 `tenant_balance_ledger`

```sql
CREATE TYPE ledger_kind AS ENUM (
  'hold',                     -- caller token issuance pre-debit (P-2 写)
  'hold_release',             -- caller hold released back without debit (P-2)
  'debit',                    -- caller actual settlement at result-landing (P-2)
  'refund',                   -- one of the 5 protocol auto-refund classes (P-2)
  'credit',                   -- responder earnings posted (P-2)
  'pending_credit_release',   -- untrusted-tier earnings released after T days (P-3)
  'pending_credit_revoke',    -- untrusted-tier earnings revoked on freeze (P-3)
  'recharge',                 -- platform recharge worker writes here (P-1 是的)
  'admin_adjustment'          -- platform ops manual adjustment (audit-only) (P-1)
);

CREATE TYPE ledger_direction AS ENUM (
  'caller_spend',
  'responder_earn',
  'system'                    -- recharge / admin_adjustment 走这一档
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

冻结点：

- `ledger_id` 是 ULID（26 字符可排序字符串），便于按时间游标分页 + 跨数据中心唯一。
- `kind` 枚举包含 P-2 / P-3 / P-4 阶段才会写的值（`hold` / `debit` / `refund` / `credit` / `pending_credit_*`）——本 RFC 在 P-1 内只**新增枚举**，不允许 P-2 阶段重新定义这些值的语义。
- `direction` 三档枚举锁死，不允许 P-2 追加。
- `prev_balance_cents` / `new_balance_cents` 是**冗余字段**，但它们让审计可在不重放整张表的前提下反查任意时刻的余额——这是合规与对账的硬刚需。
- 主索引按 `(tenant_id, recorded_at DESC, ledger_id DESC)` 建，正是 §4.2 ledger endpoint 的分页 selectivity。

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

  -- free-form provider hint (NULL in P-1; useful for P-? fiat integration)
  provider              VARCHAR(32)     NULL,
  external_reference    VARCHAR(256)    NULL,

  created_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ     NOT NULL DEFAULT now(),

  CONSTRAINT amount_positive CHECK (amount_cents > 0)
);
```

冻结点：

- `recharge_state` 枚举固定 5 档；`captured` 是唯一会修改余额的状态。
- `captured_ledger_id` 必须指向 `tenant_balance_ledger.ledger_id`（DB 层面是软外键，借助应用层保证）——这是『充值动作必有审计 trail』的物理体现。
- P-1 阶段 `provider` / `external_reference` 都允许 NULL；它们是为未来法币集成预留的接口，不在本 RFC 冻结其语义。

---

## 4. Endpoint 契约（v1 namespace, additive）

### 4.1 `GET /v1/tenants/{tenant_id}/balance`

返回该 tenant 当前余额 + 当前所有 quota 窗口的状态。

**Auth**：与该 `tenant_id` 绑定的 v0.1 caller token **或** responder token **或** ops-admin service token 之一。

**Response 200**：

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

冻结点：

- 顶层字段名与 platform 方向 RFC 附录 A.3 完全一致。
- `windows[]` 数组里**必须**至少包含 `daily | monthly | total` 三档（即使 max_amount_cents = null）。
- `rate_limit_per_second` 是从 platform 方向 RFC §3.2 引入的；P-1 阶段固定值（默认 2/s），不进 schema（属应用层配置）。
- `credit_mode` 字符串字面量在 P-1 阶段唯一允许值是 `"prepaid"`；预留给 future `"postpaid_invoice"` 的可能性，但本 RFC 不实现。

**Response 404**：tenant 不存在。

### 4.2 `GET /v1/tenants/{tenant_id}/ledger?cursor=&limit=&kind=`

按时间倒序拉余额变动明细，支持 keyset 分页。

**query 参数**：

- `cursor`（可选）：上一次响应的 `next_cursor`；首次调用不传。
- `limit`（可选）：1..200，默认 50。
- `kind`（可选）：可重复传，只返回指定 ledger_kind 的行（例 `?kind=debit&kind=refund`）。
- `since`（可选）：ISO 8601；只返回 `recorded_at >= since` 的行。

**Response 200**：

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

冻结点：

- 分页是 keyset（不是 offset）。`next_cursor` 是 base64 编码的 `(recorded_at, ledger_id)` 二元组；客户端 opaque。
- `amount_cents` 始终带正负号（caller_spend 为负、responder_earn 为正、system 视具体 kind 而定）。
- 不返回 ledger row 内的内部 reason 字段（隐私 / 防泄漏 risk 规则）。

**Response 404**：tenant 不存在。

### 4.3 `POST /v1/tenants/{tenant_id}/recharge`

**Auth**：仅平台内部 worker / ops-admin service token；caller / responder token **拒绝**。

**Request body**：

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

**Response 201**：

```json
{
  "recharge_id": "rch_01HF...",
  "state": "captured",
  "credit_balance_cents_after": 60000,
  "captured_ledger_id": "01HF8DCAPTURE111"
}
```

冻结点：

- `recharge_id` 必须由调用方提供（不允许服务端生成）；服务端只做 ULID/UUID 形式 sanity check。
- `idempotency_key` 在 P-1 阶段强制等于 `recharge_id`——给未来引入更复杂幂等模型留口子，但 P-1 内简化处理。
- 同一 `recharge_id` 的二次提交：返回 `200`（不是 `201`）+ 上次的 `captured_ledger_id`，**不**重复入账。
- 任何失败（amount<=0 / currency 不支持 / tenant 不存在 / DB 写失败）→ 不写 ledger，不创建 `tenant_recharge_request` 行。
- 本 endpoint **不**对接任何法币支付商；P-1 充值的语义是『运营把点数预存进系统』，未来法币桥接由独立 RFC 在它之上叠加。

---

## 5. quota 窗口的翻页与扣减算法

### 5.1 翻页时间锚（UTC 锁定）

| `window_kind` | 翻页时刻（UTC） |
| :--- | :--- |
| `daily`   | 每日 00:00:00 |
| `monthly` | 每月 1 日 00:00:00 |
| `total`   | 永不翻页 |

P-1 不支持运营自定义"按公司财年翻"或"按 caller 创建日翻"；如果 future 阶段需要，叠加新 `window_kind` 枚举值，不动现有三档语义。

### 5.2 lazy-reset 算法

每次 quota 检查（被 `POST /v1/calls/consent`、§4.3 recharge、`GET /v1/tenants/{tenant_id}/balance`）触发时：

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

冻结点：

- 翻页不写 `tenant_balance_ledger`——quota 窗口的 reset 不是余额变动，只是计量窗口移动。
- 翻页发出 `platform.quota_window.rolled` 事件供监控用。
- 翻页用 `SELECT FOR UPDATE` 防并发——同一 tenant 同一 window_kind 在并发请求下只会被翻一次。
- `boundary_for(kind, now_utc)` 是纯函数：daily → 同日 UTC 00:00；monthly → 同月 1 号 UTC 00:00；total → 调用方传入的 caller 创建时刻（schema migration 阶段写入）。

### 5.3 扣减事务的标准形（P-2 才会真用，P-1 的 recharge 也走这个 shape）

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

冻结点：

- `version` 列上的 CAS 是 P-1 唯一的并发控制策略；不引入 row-level pessimistic lock 在应用层。
- 余额变更 + quota 窗口 + ledger 三件事**必须**在同一 SQL 事务内；任意失败 → 全体回滚 → 抛 `ERR_BILLING_INTERNAL`。
- 缺一份 ledger 行不允许；这是 §8 不可变性自检 daemon 的核心 invariant。

### 5.4 `hard_block_on_exceed` 默认值的妥协

platform 方向 RFC §3.2 说『平台层默认值 prepaid + hard_block 开』。本 RFC **暂时把 `hard_block_on_exceed` 默认值改为 `false`**，仅在 P-1 范围内。

理由：

- P-2 才上 preflight quote。如果 P-1 阶段就 hard_block 开，P-2 上线前任何调用都没扣费但仍会被 quota block——产品行为反直觉。
- 默认 `false` 的 P-1 阶段，quota 主要承担『用量观测』作用，不承担『block 用户』责任。
- P-2 上线后，迁移脚本会把所有现有 tenant 的 `hard_block_on_exceed` 切为 `true`（同步 platform 方向 RFC 默认值）；该迁移在 P-2 阶段的实施 RFC 内冻结。

这条妥协是 P-1 与方向 RFC 的**有意识偏离**，本 RFC 显式登记，避免后人在不知情时把它改回来。

---

## 6. 错误码

P-1 阶段冻结的错误码集合（与 platform 方向 RFC 附录 A.6 对齐 + 追加）：

| 错误码 | HTTP | retryable | 触发场景 | 引入阶段 |
| :--- | ---: | :--- | :--- | :--- |
| `ERR_TENANT_NOT_FOUND` | 404 | false | tenant_id 不存在 | P-1 新 |
| `ERR_BILLING_CURRENCY_UNSUPPORTED` | 400 | false | request 提交了非 `PTS` 的 currency | platform 方向 A.6 |
| `ERR_QUOTA_EXCEEDED` | 429 | true（窗口翻页后） | hard_block_on_exceed=true 且窗口已超 cap | platform 方向 A.6 |
| `ERR_BILLING_INTERNAL` | 500 | true | 单事务内 invariant violation 或 CAS 反复失败 | platform 方向 A.6 |
| `ERR_RECHARGE_DUPLICATE_KEY` | 409 | false | 同 `recharge_id` 二次提交 + amount/currency mismatch | P-1 新 |
| `ERR_RECHARGE_NOT_AUTHORIZED` | 403 | false | caller/responder token 调 recharge endpoint | P-1 新 |

冻结点：

- 所有错误码字符串都是大写 ASCII + 下划线分隔；新加的 P-2 / P-3 / P-4 错误码必须遵循同一形态。
- HTTP status 与 retryable 含义都是契约的一部分；客户端按 retryable 决定是否自动重试。

---

## 7. 监控指标（指标 ID 冻结）

| 指标 ID | 类型 | 含义 | 默认告警阈值（草案） |
| :--- | :--- | :--- | :--- |
| `platform.tenant_balance.invariant_violation` | counter | §8 自检 daemon 检出 balance < 0 / pending < 0 / ledger 不连续的次数 | > 0 / 5min（即 P0） |
| `platform.tenant_balance.cas_retry_p99` | histogram | 单次 `apply_balance_delta` 内 CAS 重试次数 P99 | > 5 次 / 5min（提示并发竞争异常） |
| `platform.quota_window.rolled` | counter | quota 窗口翻页次数；按 window_kind 标签分 | 单 daily 窗口翻页 lag > 60s 触发（实现层做） |
| `platform.tenant_balance.imbalance_ratio` | gauge | tenant 维度的 used_as_caller / earned_as_responder 比率分布 | 单 tenant > 100x 持续 24h，进风控人工队列 |

冻结点：

- 4 条指标的 ID 字符串本 RFC 起冻结。后续阶段可以**追加**新指标（例 `platform.preflight_quote.expired` 来自 P-2），但不允许改动这 4 条的 ID。
- 阈值数值**不冻结**（运营 SLA），允许 P-2 阶段调整。
- 指标必须打到 prometheus 兼容采集；告警在 ops-console 后台 dashboard 配置（ops-console 后台 UI 是独立 RFC）。

---

## 8. 不可变性自检 daemon

P-1 上线必须同步上一个**只读**的 daemon，每 `T_check`（默认 60s）跑一次：

1. 全量扫 `tenant_balance`，断言 `credit_balance_cents >= 0` 且 `pending_credit_cents >= 0`。
2. 抽样 `tenant_balance_ledger`（每个 tenant 取最近 100 行），断言：
   - 行序 `prev_balance_cents` == 上一行 `new_balance_cents`（连续性）。
   - 行内 `new_balance_cents - prev_balance_cents` == `amount_cents` 且 `direction` 与 `kind` 一致（参考 §5.3）。
3. 按 tenant 重算 `tenant_balance.credit_balance_cents` = `last_ledger.new_balance_cents`，断言一致。
4. 任何断言失败 → bump `platform.tenant_balance.invariant_violation` + 写一条结构化告警事件 `platform.invariant_violation.detail`（字段：tenant_id、ledger_id_window、断言名、采样时间）。

冻结点：

- daemon **不修复**异常——它只检测 + 报警；修复走运营走 ops-admin token 的 `admin_adjustment` ledger kind（§3.3）。
- daemon 必须是只读路径；任何写入路径都是事故。
- daemon 在 staging 24h 无 invariant violation 才允许上 production——这是 §1.3 的 release gate。

---

## 9. 边界条件与已知妥协

### 9.1 `tenant_balance` 表记录的产生时机

- 第一次出现 tenant_id 的来源：v0.1 caller registration / responder registration 之后的下游 hook。该 hook 在本 RFC 范围内冻结为：注册成功后 platform 后端 worker 立刻 `INSERT INTO tenant_balance (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING` + `INSERT` 三档 quota window 行。
- 不允许 lazy create——避免第一次余额变动时再 create 引入的并发竞争。

### 9.2 `total` 窗口的 `window_started_at` 约定

`total` 窗口的 `window_started_at` 在表行被首次创建时一并写入，等于 tenant 的首次注册时刻；后续永远不动。如果 ops 想"重置 total 窗口"，必须显式走 `admin_adjustment` ledger + 直接 UPDATE quota_window 行，本 RFC 不为此引入新 endpoint。

### 9.3 quota lazy-reset 的 chaos 假设

P-1 release gate（§1.3 第 3 条）要求 chaos 测试覆盖：

- 多并发请求同时跨过翻页边界 → §5.2 `SELECT FOR UPDATE` 保证只翻一次。
- 数据库 failover 时 lag 5 分钟 → 翻页 lazy 计算从 `now()` 取，不从老节点缓存。
- 系统时间向后跳（NTP 漂移）→ `boundary_for(kind, now_utc)` 是单调递增条件 (`window_started_at < expected_started_at`)，向后跳不会导致虚假翻页。

### 9.4 与 v0.1 caller / responder token 的契约边界

P-1 阶段：

- v0.1 token claims 不变。
- 平台后端 worker（不是 client）负责把 caller token 中的 `tenant_id` 与 `tenant_balance.tenant_id` 关联——这层 mapping 是 platform 内部职责，本 RFC 不在 endpoint 上暴露。
- caller token 不需要 `billing.*` claims；本 RFC 上线后 caller / responder 可以查自己的余额，但不能用 token 直接花钱（花钱链路属 P-2）。

### 9.5 `currency` 字段的实现层立场

- DB 列允许任意 8 字符 ASCII，但 application 层在 P-1 阶段强制白名单 `{'PTS'}`。
- 若 P-? 法币阶段引入 `'USD'`，schema 不动；只是 application 白名单扩。
- 多 currency 之间的兑换语义、汇率管线、复合 currency 余额等，本 RFC **不**预设，留给独立 RFC。

---

## 10. 测试与发布矩阵

### 10.1 单元测试覆盖（P-1 release gate 第 4 条）

最少要覆盖：

- `apply_balance_delta` 的 happy path / 触发 invariant 的 path / CAS 重试 path
- `ensure_window_fresh` 的 daily / monthly 翻页 / `total` 不翻页
- `recharge` 幂等：同 `recharge_id` 第二次返回上次结果
- `recharge` 拒绝 caller / responder token；接受 ops-admin token
- `GET /v1/tenants/{tenant_id}/ledger` 的 keyset 分页正确性 + `kind` filter

### 10.2 契约测试（端到端）

- 走真 PostgreSQL，跑 §1.3 第 2 条要求的 `GET balance` / `GET ledger` / `POST recharge` 三 endpoint。
- 验证 schema 与 §4 完全一致（response 字段集合、type、是否可空）。
- 校验 `prev/new_balance_cents` 在多笔 recharge 后的连续性。

### 10.3 灰度策略

- shadow mode：staging 把所有 caller / responder 调用都"假装"经过 quota 检查（只产生指标、不 block），跑 7 天。
- canary：production 选 5% tenant 启用 hard_block_on_exceed=true（手动 flag，不动默认值）；监控 §7 4 条指标 24h 没 invariant violation。
- general availability：默认值仍是 `hard_block_on_exceed=false`（§5.4）；运营按需逐 tenant 切。

### 10.4 回滚路径

- migration 回滚：本 RFC 引入的 4 张表全部 `DROP`，不影响 v0.1 surface。
- 应用回滚：P-1 endpoint `GET balance` / `GET ledger` / `POST recharge` 撤下后，caller / responder 流量不受影响（v0.1 没有任何调用方依赖它们）。

---

## 11. 路线图

P-1 阶段内部 4 个 milestone：

| milestone | 主题 | 解锁 |
| :--- | :--- | :--- |
| M1.1 | DB schema migration + 单元测试 | 表存在；apply_balance_delta 可工作 |
| M1.2 | `GET /v1/tenants/{tenant_id}/balance` + ledger insert | 用户能通过自己的 token 查到自己的余额 |
| M1.3 | quota lazy-reset + `ERR_QUOTA_EXCEEDED` | 业务层准备好接 quota（即使 default off） |
| M1.4 | 监控指标 + 不可变性自检 daemon | 上 production 的最后一关 |

每个 milestone 都必须满足：

- 上一 milestone 已通过 staging 7 天观察。
- 单元测试 + 契约测试覆盖率符合 §10.1 / §10.2。
- 监控告警在 silent mode 跑过没误报。

---

## 附录 A：与 platform 方向 RFC 附录 A 的字段对照表

下面列出本 RFC 冻结的字段名 / endpoint 路径与方向 RFC 附录 A 的关系。冻结即从此以这一列为准。

| 方向 RFC（附录 A） | 本 RFC（冻结） | 对照状态 |
| :--- | :--- | :--- |
| `tenant_id` | `tenant_balance.tenant_id` | 一致 |
| `credit_balance_cents` | `tenant_balance.credit_balance_cents` | 一致 |
| `pending_credit_cents` | `tenant_balance.pending_credit_cents` | 一致 |
| `currency` | `tenant_balance.currency` | 一致；application 层 P-1 白名单 `'PTS'` |
| `windows[].window_kind` | `tenant_quota_window.window_kind` | 一致；枚举锁死 daily/monthly/total |
| `windows[].max_amount_cents` | `tenant_quota_window.max_amount_cents` | 一致；P-1 允许 NULL |
| `windows[].used_as_caller_cents` | `tenant_quota_window.used_as_caller_cents` | 一致 |
| `windows[].earned_as_responder_cents` | `tenant_quota_window.earned_as_responder_cents` | 一致 |
| `rate_limit_per_second` | （应用层配置，不在本 RFC schema 内） | 一致；endpoint response 含 |
| `credit_mode` | （应用层枚举，仅 `prepaid`） | 一致；P-1 唯一允许值 |
| `hard_block_on_exceed` | `tenant_quota_window.hard_block_on_exceed` | 一致；**默认值在 P-1 改为 `false`，§5.4 显式登记** |

---

## 附录 B：引用

- 协议方向：`repos/protocol/docs/planned/design/billing-and-quota.zh-CN.md`
- 平台 surface 方向：`repos/platform/docs/planned/design/billing-design-rfc.zh-CN.md`
- v0.1 platform API：`repos/platform/docs/current/spec/platform-api-v0.1.zh-CN.md`
- v0.1 默认值：`repos/platform/docs/current/spec/defaults-v0.1.zh-CN.md`
- 客户端同意流：`repos/client/docs/planned/design/billing-caller-consent.zh-CN.md`
