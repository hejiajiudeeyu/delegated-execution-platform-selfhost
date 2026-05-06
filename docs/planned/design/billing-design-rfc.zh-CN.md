# 平台计费 surface（Billing Design）方向定位 RFC

> 英文版：[./billing-design-rfc.md](./billing-design-rfc.md)
> 说明：中文文档为准。

状态：草案（方向定位，不冻结字段名）
分支：`repos/platform`
配套阅读：
- 本仓 → 协议方向：`repos/protocol/docs/planned/design/billing-and-quota.zh-CN.md`
- 本仓 → 客户端同意：`repos/client/docs/planned/design/billing-caller-consent.zh-CN.md`（T6-3）
- 本仓 → 第四仓集成：`changes/CHG-2026-022.yaml` 之后的 billing-rfc bundle（T6-4）

---

## 0. 写在前面

这份 RFC 不是『计费功能详细设计』，而是要回答一个范围更窄但更要紧的问题：

> 协议层方向已经定了（`billing-and-quota.zh-CN.md`）。**平台**这一仓在这条方向上要承担哪些 surface？哪些事坚决不接？

它不复述协议方向。所有"为什么按市场需求分配"、"为什么三种定价模式"、"为什么不区分主观恶意与模型不可控输出"等立场，请直接读 protocol RFC 不要在本文里翻找。

本 RFC 本身**不冻结任何字段名 / endpoint 路径 / 实际数值**。所有具体 schema 都放附录 A，由后续实现层 RFC 冻结。

---

## 1. 范围

### 1.1 平台在计费链路上的定义

在协议方向下，平台是一个**可信结算与运营层**，对外承担三件事：

1. 维护 tenant 账户、合并余额、quota 窗口（caller / responder 共用一份余额）。
2. 实施协议方向规定的"机器化判定"——preflight quote、预扣、自动结算、自动退款、trust_tier 升降级、内容审查。
3. 在 caller 与 responder 之间提供"价值结算的中间记账"，但**不**做主观仲裁、不做内容创作、不做流量分发。

平台是 OPC 网络的"清算所 + 风控 + 准入"，不是市场（market 在 brand-site）也不是创作工具。

### 1.2 与 protocol RFC 的关系

| protocol 方向 | platform RFC 这一仓接下来怎么做 |
| :--- | :--- |
| §2 按市场需求分配 | 平台不引入"成本透传"字段；不暴露 responder 内部成本 |
| §3 三种定价模式 | 平台 API 完全按 hotline `pricing_hint` 透传，自身不实现"哪种模式更合理"的判断 |
| §4.2 hotline 自报、上限封顶 | 平台层强制实现 max_total_cents 封顶，**不**计时、**不**监督内部 |
| §5.1 预扣 + 单次结算 | 平台实现两阶段：token 签发时预扣 / result 落地时实扣 |
| §5.2 自动退款 | 平台实现 5 类机器可判定退款触发器（unverified / timeout / failed / frozen / content_rejected）|
| §5.3 主观 dispute | 平台只受理 verified 以下 tier；高 tier 默认拒绝单边申诉 |
| §6 零信任 hotline | 平台实现 trust_tier 自动升降级、双盲采样、漂移检测、内容审查管线 |
| §6.7 不区分主观恶意 | 平台只看输出是否触发风险规则；不要求 responder 自证主观善意 |
| 附录 A.1.4 合并余额 | 平台 tenant 表 = 一份 credit_balance_cents + 双向 use_history |

**反向边界**：协议方向没说的事，平台 RFC 也不擅自加（不引入透传、不引入半退款、不引入主观仲裁仪表盘）。

### 1.3 非目标

- 不在本 RFC 里做 UI 设计（caller 同意流由 client RFC 负责，平台后台 UI 由后续运营 RFC）。
- 不冻结具体抽佣比例 / 退款时延 / 升降级阈值（属商业决策 / 运营 SLA）。
- 不接入法币（点数体系第一阶段不开放法币提现，见 §10.4）。
- 不复用人类外包平台的"周/月级 escrow" / "阶段验收"语义。
- 不引入"半退款 / 部分退款"/"按完成度比例退款"。
- 不为 caller 提供"内部成本面板"——caller 只看到对外承诺。

---

## 2. 平台层职责清单

把协议方向里那些机器化判定的责任落到平台这一仓后，得到下面 8 类 surface。本 RFC 第 3-10 节逐一过：

1. tenant 账户与合并余额（§3）
2. preflight quote 与 caller 同意核验（§4）
3. 扣费时机与原子性（§5）
4. auto-refund 引擎（§6）
5. trust_tier 升降级 daemon（§7）
6. 内容审查管线（§8）
7. dispute 队列（§9）
8. 抽佣 / 平台费的实现位置 + 计费事件出口（§10）

---

## 3. tenant 账户与合并余额

### 3.1 一个 tenant_id = 一份余额

延续协议方向附录 A.1.4：

- 同一 `tenant_id` 共享一份 `credit_balance_cents`。
- caller 端消费扣的余额 = responder 端调用赚到的余额（同池）。
- 不为 caller 与 responder 拆账户、不为不同 hotline 拆账户。

平台对外暴露 `GET /v1/tenants/{tenant_id}/balance` 单一资源，response 同时包含 `used_as_caller_cents` / `earned_as_responder_cents` 两条 use_history 维度——**仅信息性披露**，不影响余额合并语义。

### 3.2 quota 窗口

quota 窗口由平台维护，**不**进协议层：

- 至少 daily / monthly / total 三档窗口同时存在。
- 窗口对 caller 侧消费与 responder 侧赚取**分别记账**（避免 responder 一次大单顺便撑爆 caller 当天上限）。
- 超 quota 不直接拒绝；先看 `hard_block_on_exceed`：true → 拒绝并返 `ERR_QUOTA_EXCEEDED`，false → 警告事件 + 继续放行。
- 平台层默认值 prepaid + hard_block 开。

### 3.3 余额变动的原子性

任何余额变动事务必须满足：

- caller 预扣 / 实扣 / 退款 / responder 入账 必须**单 SQL 事务**，不允许『扣了 caller 但没记 responder』中间态。
- 失败回滚不允许写"半状态"——任意失败 → 整体放弃 → 抛 `ERR_BILLING_INTERNAL`。
- 平台不暴露"事务 id"给 caller / responder（事务边界是平台内部实现细节）。

### 3.4 合并余额带来的网络效应

合并余额是协议方向的硬要求，平台层把它视为产品基础设施：

- OPC 互调时摩擦最小（A 调 B 用余额、B 当天接到 C 的调用立刻续命余额，避免"赚了点数但要等结算"）。
- 平台无须为"caller 赚的钱能不能给 responder 用"出运营文档——天然合并。
- 平台监控指标里，`used_as_caller_cents` / `earned_as_responder_cents` 是 risk 信号源（极不平衡 = 单向消耗或单向卖账户）。

---

## 4. preflight quote 与 caller 同意核验

### 4.1 preflight 是平台 API、不是协议层 API

caller 在调 hotline 之前必须能拿到一条**报价**——这就是 preflight quote。它必须是平台 API 而不是协议 API，原因：

- 报价是 hotline 当下状态 × tenant 当下状态的函数（涉及 trust_tier / quota / 余额 / 当前定价）。
- 协议层只规定"caller 必须同意 max_charge_cents"，不规定报价怎么生成。
- 由 platform 层做报价，可在不动协议骨架的前提下接政策（限免、新人优惠、tier 折扣等运营策略）。

### 4.2 preflight 输出契约

- `pricing_model`（fixed_price / base_plus_duration / base_plus_tokens 之一，见 protocol §3）。
- `max_charge_cents`（caller 接受的金额上界）。
- `currency`（默认 PTS / Call Credit）。
- `expires_at`（quote 有效期，初值建议 5 分钟内）。
- `trust_tier_at_quote`（截至 quote 生成时 hotline 的 trust_tier 值；后续 hotline 被 frozen 不影响已签发的 quote 在 expires_at 内的可用性）。
- `responder_self_report_required`（是否需要 responder 在 result 中上报 unit count）。
- `disclaimer_required`（是否需要 hotline 提供 §6.5.3 输出风险声明）。

不暴露：

- responder 内部成本 / margin。
- 平台抽佣比例（计入总价里，不外显）。
- caller 侧的"剩余优惠次数"（这是 caller-app 的事，不是 quote 的事）。

### 4.3 caller 同意核验

token 签发时平台必须核验：

- caller token claims 里的 `billing.max_charge_cents` ≥ quote.max_charge_cents → 否则 `ERR_BILLING_MAX_CHARGE_TOO_LOW`。
- claims 的 `pricing_model` 与 quote 的 pricing_model 一致 → 否则 `ERR_BILLING_PRICING_MODEL_MISMATCH`。
- claims 的 `currency` 在平台允许列表 → 否则 `ERR_BILLING_CURRENCY_UNSUPPORTED`。
- caller 同意金额 ≤ trust_tier 上限（A.3）→ 否则 `ERR_TRUST_TIER_LIMIT_EXCEEDED`。
- caller 余额满足预扣 → 否则 `ERR_PREPAID_BALANCE_INSUFFICIENT`。
- caller 当窗口 quota 满足预扣 → 否则 `ERR_QUOTA_EXCEEDED`。

核验失败一律在 token 签发阶段拒绝；不允许"先签发 token，调用时再发现钱不够"。

### 4.4 platform 不为 caller 自动续费

平台不实现"余额不足时自动从信用卡扣款补足"。

- prepaid 模式下余额耗尽 → 拒新 token，老 token 仍可执行到结束。
- 充值通道由后续 RFC（§10.4）定义；初期仅支持点数购买入口。

---

## 5. 扣费时机与原子性

### 5.1 两阶段

承接协议方向 §5.1：

| 阶段 | 时点 | 动作 |
| :--- | :--- | :--- |
| 预扣 | token 签发成功 | tenant 余额 -= max_charge_cents；记 `caller.request.billing_held` 事件 |
| 实扣 | result 落 SUCCEEDED | 实际金额 ≤ max → 退还差额；实际金额 > max → 封顶到 max（responder 自负），记 `caller.request.billing_capped` |

### 5.2 实际金额的计算位置

- fixed_price：实际金额 = hotline `pricing_hint.unit_price_cents`。responder 上报无效。
- base_plus_duration / base_plus_tokens：实际金额 = base + responder 自报的 variable count × unit price，封顶 max_total_cents。
- 平台不审核 variable count 的"真实性"——但会把它接入 §7 漂移检测（多个 caller 同 hotline 的 variable count 分布异常 → 漂移信号）。

### 5.3 responder 入账时机

responder 入账与 caller 实扣**同事务**完成，但有两种 ledger 状态：

- responder trust_tier ≥ trusted：实扣成功 → responder 余额立刻 +=。
- responder trust_tier = untrusted：实扣成功 → 进 `pending_credit` 子账户，落账延迟（见 §7.4）。

无论 ledger 状态，caller 一侧扣款均**立刻完成**——不延迟扣款给 caller 看。

### 5.4 平台抽佣的实现位置

抽佣 = 实扣金额 - responder 入账金额。该差值：

- 在 `result.SUCCEEDED` 同事务里完成。
- 不出现在 caller / responder 的任何 API 字段里。
- 仅在 `tenant.platform_revenue` 内部账户上累计。
- 比例由运营配置（不在协议 / 平台 RFC 冻结）。

---

## 6. auto-refund 引擎

### 6.1 5 类机器可判定的全额退款

由协议 §5.2 直接导出：

| 触发器 | 检测点 | 事件 |
| :--- | :--- | :--- |
| UNVERIFIED | 平台对 result 做签名 / schema / 价格一致性校验 | `caller.request.refunded_unverified` |
| TIMED_OUT | hard_timeout 守护 daemon | `caller.request.refunded_timeout` |
| FAILED-non-retryable | result 落 FAILED 且 `error.retryable=false` | `caller.request.refunded_failed` |
| HOTLINE_FROZEN | hotline 在 prepared 期间被 frozen | `caller.request.refunded_hotline_frozen` |
| CONTENT_REJECTED | 平台内容审查在 result 落地前拒绝 | `caller.request.refunded_content_rejected` |

### 6.2 退款的语义

- **全额、自动、无 caller 申诉**——这 5 类是协议层硬规定，平台不能加判断阈值。
- 退款 = 把预扣金额从 platform escrow 退回 caller `credit_balance_cents`。
- 退款事务必须在事件落 ledger 后 ≤ 1 个 ledger tick 完成；否则告警 `platform.refund_lag`。
- 不引入"半退款 / 部分退款"——协议方向硬性禁止。

### 6.3 退款不影响 responder

- UNVERIFIED / CONTENT_REJECTED：responder 入账金额 = 0；不计 trust_tier 收益。
- TIMED_OUT / FAILED-non-retryable：同上。
- HOTLINE_FROZEN：caller 退全额，但 responder 在 frozen 之前已经完成的合法 result 仍按正常 ledger 入账——frozen 只阻止新 token 签发，不追溯已完成调用。

---

## 7. trust_tier 升降级 daemon

### 7.1 协议方向锁定的事

按 protocol §6 / 附录 A.6：

- 4 档 tier：untrusted / trusted / verified / frozen。
- frozen 与其他三档**不在同一升降级链路**——frozen 是事故路径，由 admin 或 §8 内容审查触发。
- 升降级靠机器化指标，不靠用户好评。

### 7.2 平台 daemon 负责的事

- 实时监听 5 类 ledger 事件（`pricing_drift` / `sla_drift` / `dual_call_mismatch` / `content_rejected` / `dispute_resolved`）。
- 按 protocol 附录 A.6 的阈值（实现层冻结时确定具体数值）累计窗口指标。
- 触发升降级 → 写 `hotline.tier_changed` 事件 → 影响后续 quote 上限（§4.2 trust_tier_at_quote）。

### 7.3 反刷熔断（双盲采样）

- 平台对每 N 次（建议 N=200）调用执行一次"匿名 dual call"：用同样 input 同 hotline 调一次，比较两次 result 是否在 schema 范围内一致。
- 不一致 → `dual_call_mismatch` 事件累计 → 多次累计 → 触发 trust_tier 降级。
- 双盲采样的成本由平台承担，不计入 caller 余额；它作为平台抽佣的一部分被覆盖。

### 7.4 落账延迟（pending_credit）

- untrusted tier 的 hotline 入账金额进 `pending_credit` 子账户，T 天（建议 T=7）后转入主余额。
- T 天内若该 hotline 进入 frozen，pending_credit 不释放，直接吊销。
- T 天结束 + hotline 仍在 untrusted+ → 释放进主余额。
- trusted / verified tier 不受 pending_credit 影响，立即可用。

---

## 8. 内容审查管线（§6.5 风险线 B 落地）

### 8.1 审查目标

按 protocol §6.5：平台内容审查 = trust_tier 升级条件 + 退款触发器，而不是结果可见性的开关。

实操含义：

- 审查通过 → result 正常落 SUCCEEDED → caller 可见。
- 审查拒绝 → result 落 SUCCEEDED 但平台层 mask 输出 + 触发 CONTENT_REJECTED 退款（§6.1）+ 累计 trust_tier 降级信号。

### 8.2 审查策略分级

平台不要求所有调用都过强审查。按 hotline `disclaimer.risk_level`（A.8）分级：

- `info`（默认）：不审；只在 caller 调用记录上做格式校验。
- `low`：抽样审（建议 1-5%）。
- `medium`：100% 异步审（不阻塞 caller 拿到 result，但触发延后 mask + 退款 + 降级）。
- `high`：100% 同步审（在 result 落 SUCCEEDED 之前阻塞）。

`high` 是唯一会"卡 caller"的档；其他档位都允许 result 先到 caller，再后置处理。

### 8.3 审查 worker 接入

平台内置 5 类规则引擎（不全交给 LLM 审查，避免误杀正当 hotline）：

| 规则 | 检测目标 |
| :--- | :--- |
| prompt_injection | 输出含明显 jailbreak / role-override 模板 |
| executable_payload | 输出含可执行 shell command / SQL injection / XSS payload |
| pii_leak | 输出含 PII 但 hotline 没声明 PII output |
| disallowed_category | 输出落入 hotline `disclaimer.disallowed_outputs[]` 范围 |
| schema_violation_post_check | 已通过 schema 但语义二次检查失败（如 number 字段越界） |

每条规则触发 → `content_review.rejected` 事件 + 走 §6.1 CONTENT_REJECTED 退款路径。

### 8.4 caller 端的体感

- 大多数 hotline 落在 info / low → caller 几乎感觉不到审查存在。
- medium / high 档 hotline → quote.disclaimer_required = true，caller 同意流（client RFC）必须显示 disclaimer。
- result 被 CONTENT_REJECTED → caller 在 console 看到红色"内容审查未通过，已自动退款"——不展示 mask 后的内容（避免规避审查）。

### 8.5 不在范围

- 不引入 hotline 自定义 LLM 审查器（防止 responder 自审自卖）。
- 不公开规则细节给 hotline 调试（防止针对性绕过）；hotline 拒绝后只返回类目，不返回触发的具体子规则。
- 不审 caller 提交的输入（输入安全是 caller-side 的责任）。

---

## 9. dispute 队列（少数路径）

### 9.1 受理范围

按 protocol §5.3：

- caller 端"result 走 SUCCEEDED 但主观不满意"。
- **仅** untrusted / trusted tier 的 hotline 受理。
- verified tier 的 hotline 默认拒绝单边申诉（response: `ERR_DISPUTE_NOT_ACCEPTED_FOR_TIER`）。

### 9.2 流程

- caller 提交 dispute → 进 platform 运营队列。
- 队列默认 SLA：14 个工作日内回复（具体 SLA 属运营，本 RFC 不冻结）。
- 仅 3 种结局：维持原扣款 / 全额退（同 §6.2 语义）/ 标 hotline 待 admin review。
- 不存在"半退" / "扣 hotline 30%"——所有 dispute 都是离散决策。

### 9.3 防滥用

- 同一 caller 月度 dispute 提交率超阈值 → 自动暂停申诉权限 30 天。
- dispute 通过率（caller 胜诉率）计入 caller 风控指标 — 只用于内部风控，不公开。
- 不允许 caller 在拿到 result 之后主动调用 hotline 多次再批量 dispute（每个 request 一次申诉机会）。

### 9.4 不在范围

- 不为 dispute 提供反馈 / 评分机制——评价生态另起 RFC。
- 不公开 dispute 队列状态给 responder（仅在结局事件 `dispute.resolved` 通知 responder）。
- 不引入 "responder 反诉"。

---

## 10. 抽佣 / 平台费的实现位置 + 计费事件出口

### 10.1 抽佣的位置

见 §5.4：抽佣 = 实扣金额 - responder 入账金额。

- 不暴露给 caller / responder 任何字段。
- 比例由运营配置 / 单 hotline 谈判 / 全局兜底。
- platform_revenue 内部账户每日 ledger close 写入 `platform.daily_revenue` 事件，仅平台运营可见。

### 10.2 平台费的去向

- 双盲采样成本（§7.3）。
- 内容审查 worker 成本（§8.3）。
- auto-refund 池（§6 退款发生时余额来自这里）。
- 长期：平台运营 / 客服 / 法务。

caller / responder 不应感知平台费的具体分配。

### 10.3 计费事件出口

平台对外提供一条 webhook 通道（POST 到 caller / responder 各自配置的 endpoint），包含：

- `caller.request.billing_held / billing_capped / refunded_*`
- `responder.request.credited / pending_credit_released / pending_credit_revoked`
- `hotline.tier_changed / pricing_drift / sla_drift`

不包含：

- 平台抽佣金额。
- 其他 tenant 的事件（隔离）。
- 内容审查规则细节（§8.5）。

webhook 失败重试 3 次 + 持久化 dead-letter，不允许 caller / responder 错过结算事件。

### 10.4 不接入法币

第一阶段：

- `currency` 默认 `PTS`（点数）。
- 充值入口可绑定法币购买点数（合规由平台所在司法辖区运营层处理），但点数本身**不开放兑回法币**。
- 这条立场进 brand-site 和 client RFC（caller 同意流必须明确告知"非法币、不可提现"）。

第二阶段（无明确时间表）：

- 若开放法币提现，按 ISO 4217 currency code 与 KYC / 反洗钱合规一并设计；属新 RFC。

---

## 11. 不在本 RFC 范围

下列内容承认存在，但本 RFC 不细化，留给后续：

- 抽佣比例的具体数字（商业决策）。
- pending_credit T 天的 T 值（运营 SLA）。
- preflight quote 的 expires_at 具体秒数（实现层）。
- webhook 的 schema / 重试策略（实现层）。
- 内容审查规则细节字段（§8.5 已说明不公开）。
- 法币接入与 KYC（独立 RFC）。
- 平台运营后台 UI（独立 ops-console 设计）。
- "OPC 之间互调时的链式抽佣"（OPC chain billing，protocol 方向尚未定，暂不在 platform 落实）。
- "多 responder 联合接单"（multi-responder split，protocol 方向尚未定）。

---

## 12. 后续 milestone

平台 RFC 的实施按 4 个阶段推进，每段都对应一个未来的实现层 RFC（不在本仓本 RFC 内冻结）：

| 阶段 | 主题 | 解锁 |
| :--- | :--- | :--- |
| P-1 | tenant 账户 + 合并余额 + quota 窗口 | 让 free tier 用户有"账"可挂 |
| P-2 | preflight + 同意核验 + 两阶段扣费 + 5 类 auto-refund | 让"调用 = 真扣点数"成立 |
| P-3 | trust_tier daemon + 反刷熔断 + 内容审查 (info/low/medium 档) | 让 hotline 不再是无成本提交 |
| P-4 | dispute 队列 + 内容审查 high 档 + 抽佣账册 + webhook 出口 | 让平台运营有据可查 |

每阶段必须满足：

- 之前阶段已上线且监控指标稳定。
- 实现层 RFC 通过 protocol + platform + client 三方 review。
- caller-side UI 同步更新（含 disclaimer 展示、退款 toast）。

---

## 附录 A：surface 草案（不冻结）

### A.1 `GET /v1/preflight`

请求：

```json
{
  "hotline_id": "foxlab.text.classifier.v1",
  "caller_tenant_id": "user_acme",
  "input_summary_hint": "10 KB transcript"
}
```

响应：

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

caller 同意 quote 后调，平台按 §4.3 核验、写入 token claims。

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

`pending_credit_cents` 是 §7.4 的 untrusted-tier 落账延迟金额；可见但不可花。

### A.4 `POST /v1/disputes`

```json
{
  "request_id": "req_01HFA1ZZZ",
  "reason_category": "incorrect_output | did_not_follow_input | broken_response_format | other",
  "free_text": "..."
}
```

平台返回 `dispute_id`；后续状态变化通过 webhook 通知。

### A.5 webhook 事件 envelope

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

`signature` 是平台对 `event_id || tenant_id || occurred_at || payload` 的签名，caller / responder 必须验证签名再 ack。

### A.6 错误码（追加，不替换 v0.1，与 protocol 附录 A.2.1 对齐）

承接 protocol 附录 A.2.1 的 10 个错误码，平台层在它们之上**追加**：

| 错误码 | HTTP | retryable | 触发场景 |
| :--- | ---: | :--- | :--- |
| `ERR_BILLING_INTERNAL` | 500 | true | 平台事务回滚导致扣费 / 入账失败 |
| `ERR_DISPUTE_NOT_ACCEPTED_FOR_TIER` | 403 | false | dispute 提交但 hotline 已 verified |
| `ERR_DISPUTE_RATE_LIMITED` | 429 | true（窗口翻页后） | caller 申诉权限暂停期内 |
| `ERR_QUOTE_EXPIRED` | 410 | true（重新 preflight） | quote_id 已过 expires_at |
| `ERR_QUOTE_NOT_FOUND` | 404 | false | quote_id 不存在或已使用 |
| `ERR_PENDING_CREDIT_INSUFFICIENT` | 409 | false | responder 想花未释放的 pending_credit |

---

## 附录 B：引用

- 协议方向：`repos/protocol/docs/planned/design/billing-and-quota.zh-CN.md`
- 协议附录 A.1.4 合并余额：同上 §A.1.4
- 协议附录 A.6 升降级阈值：同上 §A.6
- 协议附录 A.8 disclaimer：同上 §A.8
- v0.1 平台 API：`repos/platform/docs/current/spec/platform-api-v0.1.zh-CN.md`
- v0.1 默认值：`repos/platform/docs/current/spec/defaults-v0.1.zh-CN.md`
