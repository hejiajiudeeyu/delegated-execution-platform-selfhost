# Data Collection Plan（MVP）

目的：定义服务端采集哪些数据，分别用于协议观测、运行维护和实现演进。  
原则：默认不采集任务正文，不采集长期密钥，不采集不必要个人信息。

更新时间：2026-03-02

## 1) 协议观测（外部可见）

用于协议观测页或公开状态页的聚合信息：
- `seller_id`, `subagent_id`, `display_name`, `capabilities`, `version`
- `call_volume`（调用量）
- `success_rate`, `timeout_rate`, `schema_compliance_rate`
- `p95_exec_ms`, `sample_size`
- `availability_status`（healthy/degraded/offline）
- `eta_hint`（queue/exec p50/p95）

展示规则：
- 仅展示聚合指标，不展示单条任务数据。
- 展示时同时带出 `sample_size`，避免脱离样本量解读。

## 2) 运行维护（稳定性）

用于日常运维、时延观察、异常排查：
- 心跳数据：`seller_id`, `timestamp`, `queue_depth`, `est_exec_p95_s`
- 请求事件：`request_id`, `event_type(ACKED|COMPLETED|FAILED)`, `at`, `eta_hint_s(optional)`, `finished_at(optional)`, `error_code(optional)`
- 指标事件：`source`, `event_type`, `timestamp`, `seller_id`, `subagent_id`
- 目录变更审计：导入批次号、操作者、变更时间、变更项
- token 审计摘要：签发时间、过期时间、`buyer_id/seller_id/subagent_id/request_id`（不存 token 明文）

## 3) 实现演进（调优与路由）

用于后续策略优化的数据：
- 买家选路与结果：
  - 选择了哪个 `subagent_id`
  - 是否 ACK 超时
  - 最终状态（成功/失败/超时/不合规）
- 延迟分层：
  - `T_ack_wait`（发单到 ACK）
  - `T_result_wait`（ACK 到结果回包）
  - `T_total`（端到端）
- 质量与异常：
  - 校验失败类型（签名失败、schema 失败）
  - 超时或拒绝原因摘要

注：MVP 先以调用量与硬指标为主，不引入主观打分规则。

## 4) 明确不采集（MVP）

- 任务正文 `task.input` 全量内容（默认不入库）
- 结果正文 `result.output` 全量内容（默认不入库）
- transport 原始消息全文（仅保留必要元数据）
- token 原文与卖家私钥

如确需采样内容用于质检，必须额外开关并做脱敏与最小化留存。

## 5) 最小数据模型（建议）

建议服务端至少有以下表：
- `catalog_items`
- `catalog_import_batches`
- `task_tokens_audit`
- `request_events`
- `seller_heartbeats`
- `metrics_events`
- `metrics_daily_agg`

## 6) 留存建议

- `request_events`：90 天
- `seller_heartbeats`：30 天（用于在线率分析）
- `metrics_events`：180 天
- `metrics_daily_agg`：长期保留
- `catalog_import_batches`：长期保留（审计）

## 7) 对外口径建议

对外说明统一强调：
- 平台不转发任务正文
- 平台默认不存任务/结果正文
- 对外只公开聚合硬指标
