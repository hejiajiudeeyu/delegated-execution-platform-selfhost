# Protocol Control Plane API v0.1（MVP）

本文档定义 `Remote Hotline Protocol` 的最小控制面 API：身份、目录、模板下发、token、请求事件、指标。  
当前仓库已实现的联调模式为 `L0 local transport`；控制面只依赖 `Transport Adapter` 抽象，`Email MCP` 只是候选外部通信模式之一。这里描述的是协议参考控制面，而不是要求所有实现共享同一个集中式托管后端。

## 1. 设计边界

- 平台职责：目录索引、授权签发、指标聚合。
- 非职责：任务正文代理转发、Responder 执行编排、长期密钥托管。
- 超时边界：平台不提供“远端执行进程 kill”语义；Caller 侧超时仅影响 Caller 本地等待状态。
- 版本策略：`/v1` 路径版本 + 字段向后兼容扩展。

## 2. 通用约定

## 2.1 Content-Type
- 请求与响应均使用 `application/json; charset=utf-8`

## 2.2 鉴权（v0.1 冻结）
- 统一使用 `API Key` 鉴权。
- 建议请求头：`Authorization: Bearer <API_KEY>`。
- API Key 绑定 `user_id + role_scopes`，服务端按 scope 与资源归属做鉴权（默认 `caller`，当对应 remote hotline 完成 onboarding/导入后可激活 `responder`）。

当前实现补充：
- `POST /v1/tokens/task`、`POST /v1/requests/{request_id}/delivery-meta`：要求 `caller` 身份。
- `POST /v1/tokens/introspect`、`POST /v1/requests/{request_id}/ack`、`POST /v2/responders/{responder_id}/heartbeat`：要求 `responder` 身份，且命中 `responder_id/hotline_id` 资源归属。

## 2.3 时间、ID 与身份映射
- 时间：ISO8601 UTC（如 `2026-03-02T12:00:00Z`）
- `request_id`：UUIDv7 推荐
- 分页：使用 `next_page_token`
- `user_id`：用户主体标识（注册后默认具备 `caller`）
- `caller_id`：v0.1 默认与 `user_id` 同值映射
- `responder_id`：首次 remote hotline onboarding 审核通过后创建并绑定 `owner_user_id`
- `owner_user_id`：remote hotline 提交人与资源归属主键（`owner_user_id -> responder_id -> hotline_id`）

## 2.4 通用错误响应

所有 HTTP 错误响应均使用嵌套结构化格式：

```json
{
  "error": {
    "code": "AUTH_UNAUTHORIZED",
    "message": "API key is missing or invalid",
    "retryable": false
  }
}
```

字段说明：
- `code`（string）：机器可读的错误码
- `message`（string）：人类可读的错误描述
- `retryable`（boolean）：是否建议客户端自动重试

`retryable` 规则：
- `AUTH_*`：`false`（凭证/权限问题不可自动重试）
- `CONTRACT_*`：`false`（请求格式错误需修正）
- `CATALOG_*` / `REQUEST_NOT_FOUND` / `RESPONDER_NOT_FOUND` / `USER_NOT_FOUND`：`false`
- `*_BINDING_MISMATCH`：`false`
- `PLATFORM_NOT_CONFIGURED` / `TRANSPORT_NOT_CONFIGURED`：`false`（配置问题）
- `*_INTERNAL_ERROR` / 500 错误：`true`（临时故障可重试）
- `RESULT_NOT_READY`：`true`（结果尚未就绪，可稍后重试）

实现口径：
- 中心错误码注册表位于 `@delexec/contracts`，服务端结构化错误响应默认以该注册表为准推导 `retryable`。
- 新增标准错误码时，应先更新中心注册表，再补服务逻辑与文档。

附加字段可出现在 `error` 对象同级，例如：

```json
{
  "error": { "code": "not_found", "message": "no matching route", "retryable": false },
  "path": "/v1/unknown"
}
```

错误码分域：
- `AUTH_*`
- `CONTRACT_*`
- `EXEC_*`
- `RESULT_*`
- `DELIVERY_*`
- `TEMPLATE_*`
- `PLATFORM_*`
- 以及当前实现已使用的 `CATALOG_*`、`REQUEST_*`、`RESPONDER_*`、`USER_*`、`HOTLINE_*`、`TRANSPORT_*`、`SIGNER_*`、`TASK_*`、`CALLER_*`、`RELAY_*`、`OPS_*`

当前实现使用的 `AUTH_*` 错误码：
- `AUTH_UNAUTHORIZED`：API Key 无效或缺失
- `AUTH_TOKEN_INVALID`：task token 解析或签名校验失败
- `AUTH_TOKEN_EXPIRED`：task token 已过期
- `AUTH_RESOURCE_FORBIDDEN`：scope 正确但资源归属不匹配

## 2.5 用户注册 API

- 方法：`POST /v1/users/register`
- 用途：创建用户主体，默认激活 `caller` scope，并签发 API Key

请求字段（Body）：
- `contact_email`（当前实现必填；兼容旧字段 `email`）
- `display_name`（文档保留，当前实现未强制）
- `organization_name`（可选）
- `locale`（可选）

201 响应示例：
```json
{
  "user_id": "user_01htz0demo",
  "contact_email": "demo@example.com",
  "roles": ["caller"],
  "api_key": "sk_live_once_only_xxx",
  "created_at": "2026-03-05T08:00:00Z"
}
```

说明：
- `api_key` 明文仅返回一次，服务端仅保存摘要。
- 注册不会直接激活 `responder`；需对应 remote hotline 完成 onboarding/导入后激活。

## 3. 目录 API

## 3.1 查询 hotlines

- 方法：`GET /v2/hotlines`
- 用途：Caller 检索可调用 hotline

Query 参数：
- `status`（可选，默认 `enabled`）
- `availability_status`（可选，`healthy|degraded|offline`）
- `task_type`（可选）
- `capability`（可选）
- `tag`（可选）

200 响应示例：
```json
{
  "items": [
    {
      "hotline_id": "foxlab.text.classifier.v1",
      "responder_id": "responder_foxlab",
      "display_name": "FoxLab Text Classifier",
      "capabilities": ["classification", "customer_support"],
      "task_types": ["text_classification"],
      "status": "enabled",
      "availability_status": "healthy",
      "last_heartbeat_at": "2026-03-02T11:59:50Z",
      "sla_hint": {
        "p95_exec_ms": 3500,
        "timeout_rate_7d": 0.02
      },
      "eta_hint": {
        "queue_p50_s": 8,
        "exec_p50_s": 35,
        "exec_p95_s": 120,
        "sample_size_7d": 340,
        "updated_at": "2026-03-02T12:00:00Z"
      },
      "responder_public_key_pem": "-----BEGIN PUBLIC KEY-----...",
      "delivery_meta_mode": "request_scoped",
      "template_ref": "docs/templates/hotlines/foxlab.text.classifier.v1/"
    }
  ],
}
```

### 3.1.1 Caller 筛选最小字段集（冻结）

`GET /v2/hotlines`（以及后续 `GET /v1/catalog/search`）应保证以下字段可用：

- 身份：`hotline_id`、`responder_id`
- 展示：`display_name`
- 可用性：`status`、`availability_status`、`last_heartbeat_at`
- 验签材料：`responder_public_key_pem`（公钥轮换窗口可返回 `responder_public_keys_pem[]`）
- 合约构建入口：`template_ref`

以下字段属于推荐增强，不是 L0 必备：
- `capabilities[]`、`supported_task_types[]`、`version`
- `sla_hint.*`、`eta_hint.*`

`GET /v1/catalog/search` 额外字段（仅搜索模式）：
- `score`、`match_reasons`、`score_breakdown`

说明（可扩展性）：
- 当前建议优先使用遍历/分类过滤。
- `task_delivery` / `result_delivery` 不在目录批量接口返回；Caller 需在 token 签发后按 `request_id` 单次申请投递元数据。
- `task_delivery.address` 的值只保证是可投递的 opaque transport endpoint，不保证是邮箱地址、URL 或固定 URI 形态。
- 当前实现会在目录列表直接返回 `responder_public_key_pem`，供 Caller 在创建本地请求记录与验签时绑定信任根。
- 后续可新增 `GET /v1/catalog/search`，支持联想、模糊匹配与领域策略。
- 为保持兼容，`GET /v2/hotlines` 长期保留，不因搜索增强而下线。

## 3.2 hotline registration / catalog submission

- 方法：`POST /v2/hotlines`
- 用途：正式提交 responder / hotline onboarding 草案
- 调用方：`caller` 或 `responder`

当前实现采用双轴状态：
- 审核态：`review_status = pending | approved | rejected`
- 运行态：`status = enabled | disabled`

公开目录与远程调用仅在以下条件同时满足时成立：
- `responder.review_status=approved`
- `hotline.review_status=approved`
- `responder.status=enabled`
- `hotline.status=enabled`

首个 responder 提交时：
- 自动创建 responder identity 和 responder API key
- `responder.review_status=pending`
- `hotline.review_status=pending`
- `responder.status=disabled`
- `hotline.status=disabled`

201 响应最小字段：
- `responder_id`
- `hotline_id`
- `responder_review_status`
- `hotline_review_status`
- `responder_status`
- `hotline_status`
- `catalog_visibility`
- `submission_version`
- `responder_api_key`（仅首次创建 responder 时返回）

兼容路径：
- `POST /v2/responders/register` 仍保留一期兼容，但内部转调正式 onboarding 核心。

## 3.3 获取 hotline 详情

- 方法：`GET /v2/hotlines/{hotline_id}`
- 用途：返回目录详情与最近一次提交流水摘要

访问规则：
- 公开态 hotline：返回 sanitize 后的公开详情
- `pending/rejected/disabled`：仅 owner 或 admin 可见完整详情

owner/admin 视角可见：
- 当前 `review_status/status`
- `submission_version`
- 最近审核备注
- 最近一次 `review_test` 摘要
- 最近提交 payload 快照

## 3.4 获取能力声明模板包

- 方法：`GET /v2/hotlines/{hotline_id}/template-bundle`
- 用途：Caller 按目录条目中的 `template_ref` 拉取模板，构造合约输入输出

Path 参数：
- `hotline_id`

Query 参数：
- `template_ref`（可选，建议透传目录项值；服务端用于一致性校验）

请求头（可选，后续增强）：
- `If-None-Match: "<etag>"`（当前未实现，预留）

200 响应示例：
```json
{
  "template_ref": "docs/templates/hotlines/foxlab.text.classifier.v1/",
  "input_schema": {
    "type": "object"
  },
  "output_schema": {
    "type": "object"
  }
}
```

L0 最小要求：
- `input_schema`
- `output_schema`

可选增强字段：
- `example_contract`
- `example_result`
- `readme_markdown`
- `template_version`
- `ETag`

状态码约定：
- `200`：返回模板包
- `304`：`ETag` 命中，无需重复下发（后续增强，当前未实现）
- `404`：`TEMPLATE_NOT_FOUND`
- `409`：`TEMPLATE_REF_MISMATCH`（传入 `template_ref` 与目录当前绑定不一致）

## 3.5 Admin review test（隐藏审核测试）

- 方法：`POST /v2/admin/hotlines/{hotline_id}/review-tests`
- 用途：管理员对待审核 hotline 发起隐藏审核测试
- 当前自动化范围：仅支持平台可直连的 `local://` / relay-backed task delivery

配套接口：
- `GET /v1/admin/review-tests`
- `GET /v1/admin/review-tests/{request_id}`

语义：
- 使用平台保留的 synthetic caller 身份创建隐藏请求
- 复用真实 token / delivery-meta / responder 执行 / result verify 主链
- 结果仅进入审核测试记录，不进入公开目录
- review test 通过不会自动触发 approve

## 3.6 Admin review / runtime actions

管理员动作：
- `POST /v2/admin/responders/{responder_id}/approve|reject|enable|disable`
- `POST /v2/admin/hotlines/{hotline_id}/approve|reject|enable|disable`

语义：
- `approve`：设置 `review_status=approved`，并在首次审批时默认同步 `status=enabled`
- `reject`：设置 `review_status=rejected` 且 `status=disabled`
- `disable`：只改 `status=disabled`
- `enable`：仅允许对已 `approved` 的 responder/hotline 恢复 `status=enabled`

可见性规则：
- responder 被 reject/disabled 时，其所有 hotline 保持 `catalog_visibility=hidden`
- 单个 hotline 被 reject/disabled 仅影响该 hotline

## 4. Token API

## 4.1 任务 token 签发

- 方法：`POST /v1/tokens/task`
- 用途：Caller 为单次任务申请短期授权

请求字段（Body）：
- `request_id`
- `responder_id`
- `hotline_id`

说明：
- `caller_id` 由 API Key 绑定身份推导，不要求调用方显式传入。
- `ttl_seconds` 不属于 L0 必填参数；v0.1 默认使用平台冻结的 `token_ttl_seconds`。

201 响应示例（当前实现）：
```json
{
  "task_token": "<JWT_OR_EQUIVALENT>",
  "claims": {
    "iss": "delexec-platform-api",
    "aud": "responder_foxlab",
    "sub": "caller_acme",
    "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
    "hotline_id": "foxlab.text.classifier.v1",
    "iat": 1770004200,
    "jti": "tok_01htz0demo",
    "exp": 1770005100
  }
}
```

## 4.2 token introspect（v0.1 必做）

- 方法：`POST /v1/tokens/introspect`
- 用途：Responder 在线查询 token 是否有效（v0.1 统一校验模式）

请求字段（Body）：
- `task_token`

鉴权约束：
- 调用方需具备 `responder` scope。
- 平台需校验调用方是否命中资源归属（`owner_user_id -> responder_id -> hotline_id`）。
- 当前实现的 responder 权限失败返回：`AUTH_SCOPE_FORBIDDEN` 或 `AUTH_RESOURCE_FORBIDDEN`。

200 响应示例：
```json
{
  "active": true,
  "claims": {
    "iss": "delexec-platform-api",
    "aud": "responder_foxlab",
    "sub": "caller_acme",
    "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
    "hotline_id": "foxlab.text.classifier.v1",
    "exp": 1770005100
  }
}
```

## 5. Metrics API

## 5.1 事件上报

- 方法：`POST /v1/metrics/events`
- 用途：Caller/Responder 提交最小观测事件

说明：
- 不属于 L0 闭环的阻塞接口。
- L0 可以先实现最小事件接收；聚合分析属于后续增强。

请求字段（Body）：
- `source`：`caller|responder`
- `event_type`：如 `request_succeeded|request_timeout|schema_invalid|signature_invalid`
- `request_id`（可选）
- `timestamp`（可选）
- `payload`（可选，扩展）

扩展字段（可选）：
- `caller_id`
- `responder_id`
- `hotline_id`

鉴权约束：
- 调用方需通过认证（`requireAuth`）。
- 当前实现不按 `source` 区分 scope；后续版本将增加 `source=caller` 需 caller scope、`source=responder` 需 responder scope 的校验。

202 响应示例：
```json
{
  "accepted": true,
  "event": { "source": "caller", "event_type": "caller.request.dispatched", "request_id": "..." }
}
```

## 5.2 聚合查询

- 方法：`GET /v1/metrics/summary`
- 用途：提供协议观测与实现对照所需的聚合硬指标

说明：
- 不属于 L0 最小闭环。
- 当前实现返回最小聚合结构，按事件类型计数。后续版本将扩展为完整的指标窗口聚合。

200 响应示例（当前实现）：
```json
{
  "total_events": 42,
  "by_type": {
    "caller.request.dispatched": 15,
    "caller.request.succeeded": 12,
    "responder.task.received": 15
  }
}
```

后续目标响应（规划中，当前未实现）：
```json
{
  "window": "7d",
  "hotline_id": "foxlab.text.classifier.v1",
  "sample_size": 120,
  "call_volume": 120,
  "success_rate": 0.94,
  "timeout_rate": 0.03,
  "schema_compliance_rate": 0.98,
  "p95_exec_ms": 4100
}
```

## 6. Request Coordination API（delivery-meta/ACK/状态事件）

该组接口用于请求投递协调与轻量状态回传，避免 Caller 无效等待。  
注意：只传事件摘要，不传任务正文与结果正文。
v0.1 实现范围：`delivery-meta` + `ACKED` + Responder 完成态观测事件（`COMPLETED/FAILED`）。

说明：
- Caller Controller 与 Caller Agent 之间的内部接口（如 `GET /controller/requests/{request_id}`、`POST /controller/requests/{request_id}/timeout-decision`）属于实现内部接口，不属于平台对外 API。

## 6.1 Caller 申请投递元数据（delivery-meta）

- 方法：`POST /v1/requests/{request_id}/delivery-meta`
- 用途：Caller 在 token 签发后，按单次请求拉取目标 responder 的投递元数据

Path 参数：
- `request_id`

请求字段（Body）：
- `responder_id`（必填）
- `hotline_id`（必填）
- `task_token`（可选，建议传入用于 claims 交叉校验）

鉴权约束：
- 调用方需具备 `caller` scope。
- 平台校验调用方对该 `request_id` 的归属（`caller_id` 命中）以及 `responder_id/hotline_id` 一致性。

200 响应示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "responder_id": "responder_foxlab",
  "hotline_id": "foxlab.text.classifier.v1",
  "task_delivery": {
    "kind": "local",
    "address": "local://relay/responder_foxlab/foxlab.text.classifier.v1",
    "thread_hint": "req:018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41"
  },
  "result_delivery": {
    "kind": "email",
    "address": "caller@example.com",
    "thread_hint": "req:018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41"
  },
  "verification": {
    "display_code": "RSA-7K4P-91QX"
  },
  "responder_public_key_pem": "-----BEGIN PUBLIC KEY-----..."
}
```

状态码约定：
- `404`：目录或请求不存在
- `403/409`：与 token/目录绑定不一致

## 6.2 Responder ACK（已接单）

- 方法：`POST /v1/requests/{request_id}/ack`
- 用途：Responder 通过校验并开始处理后，快速确认“已接单”

Path 参数：
- `request_id`

请求字段（Body）：
- `responder_id`（必填）
- `hotline_id`（必填）
- `eta_hint_s`（可选）

约束：
- 对同一 `request_id` 幂等。
- 平台校验调用方具备 `responder` scope 且 `owner_user_id -> responder_id -> hotline_id` 绑定命中。
- 可校验是否与已签发 token 的 `aud/hotline_id` 对齐。

202 响应示例：
```json
{
  "accepted": true,
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41"
}
```

## 6.3 Responder 状态事件上报

- 方法：`POST /v1/requests/{request_id}/events`
- 用途：Responder 上报轻量状态事件；v0.1 当前实现支持 `COMPLETED/FAILED`，`RUNNING/PROGRESS` 仍为后续扩展。

请求字段（Body）：
- `responder_id`
- `hotline_id`
- `event_type`（v0.1 当前实现：`FAILED|COMPLETED`；后续可扩展 `RUNNING|PROGRESS`）
- `finished_at`（可选，ISO8601 UTC；未提供则服务端落库时间为准）
- `status`（可选，建议 `ok|error`）
- `error_code`（可选，仅失败时建议带）
- `progress`（可选，后续扩展）
- `message`（可选，后续扩展）

202 响应示例：
```json
{
  "accepted": true,
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "event": {
    "event_type": "COMPLETED",
    "actor_type": "responder",
    "responder_id": "responder_foxlab",
    "hotline_id": "foxlab.text.classifier.v1",
    "status": "ok",
    "finished_at": "2026-03-02T12:01:00Z"
  }
}
```

## 6.4 Caller 查询请求事件

- 方法：`GET /v1/requests/{request_id}/events`
- 用途：Caller 轮询 ACK/完成态事件，减少盲等并获得控制面观测信息

Query 参数（后续增强，当前未实现）：
- `since`（可选，后续增量查询预留）
- `limit`（可选，后续分页预留）

200 响应示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "events": [
    {
      "event_type": "ACKED",
      "at": "2026-03-02T12:00:20Z",
      "actor_type": "responder",
      "eta_hint_s": 12
    },
    {
      "event_type": "COMPLETED",
      "at": "2026-03-02T12:00:23Z",
      "actor_type": "responder",
      "responder_id": "responder_foxlab",
      "hotline_id": "foxlab.text.classifier.v1",
      "status": "ok",
      "finished_at": "2026-03-02T12:00:23Z"
    }
  ]
}
```

## 7. Responder Heartbeat API

心跳用于反映 responder 在线状态与基础负载，不替代单请求 ACK。

## 7.1 上报心跳

- 方法：`POST /v2/responders/{responder_id}/heartbeat`
- 用途：Responder 周期性上报在线状态

Path 参数：
- `responder_id`

请求字段（Body）：
- `status`（可选，默认 `healthy`）
- `queue_depth`（可选）
- `est_exec_p95_s`（可选）

鉴权约束：
- 调用方需具备 `responder` scope。
- 平台需校验 `owner_user_id -> responder_id` 绑定关系。

202 响应示例：
```json
{
  "accepted": true,
  "responder_id": "responder_foxlab",
  "status": "healthy",
  "last_heartbeat_at": "2026-03-02T12:00:30Z"
}
```

## 7.2 可用性判定（建议默认）

- `heartbeat_interval_s = 30`
- `degraded_threshold_s = 90`
- `offline_threshold_s = 180`

状态规则：
- `healthy`：`now - last_heartbeat_at <= 90s`
- `degraded`：`90s < now - last_heartbeat_at <= 180s`
- `offline`：`now - last_heartbeat_at > 180s`

## 8. 手工导入目录模板

MVP 目录注册采用手工导入，模板文件见：
- `docs/templates/catalog-hotline.template.json`（单条模板）
- `docs/templates/catalog-hotlines.import.template.ndjson`（批量模板）

能力声明模板（详见 `architecture.md` §4.5）：
- 每个 hotline 在 `docs/templates/hotlines/{hotline_id}/` 下维护 `input.schema.json`、`output.schema.json`、`example-contract.json`、`example-result.json`、`README.md`。
- 目录条目通过 `template_ref` 字段绑定模板语义，Caller 选定 hotline 后通过 `GET /v2/hotlines/{hotline_id}/template-bundle` 拉取模板包。

建议导入流程：
本节属于 post-L0 onboarding 规划，不是 v0.1 L0 必需能力。

后续若恢复在线/半在线 onboarding，建议流程为：
1. 用户先调用 `POST /v1/users/register` 完成注册（默认 `caller`）。
2. 用户提交 remote hotline 草案（携带 `owner_user_id`）。
3. 平台管理员在模板中填写/修订 `hotline_id/responder_id/capabilities/supported_task_types` 并建立关联。
4. 使用 CLI 执行校验与审核导入。
5. 首次导入成功后，平台激活该用户 `responder` scope，并记录资源绑定关系。
6. 平台记录导入批次号与审计信息，并通过 `GET /v2/hotlines` 抽样核对。

## 9. 检索增强预留（后续规划，不在 v0.1 实现）

本节属于 post-L0 检索增强规划，不是 v0.1 L0 必需能力。

为支持增强检索能力，建议预留以下查询参数/字段：
- `q`：自由文本查询
- `fuzzy`：模糊匹配开关
- `domain`：领域策略（如 `legal|finance|biomed`）
- `filter_profile`：筛选策略标识

建议预留以下响应字段：
- `score`：综合相关性分
- `match_reasons`：命中原因（关键词、同义词、标签）
- `score_breakdown`：分项得分（文本匹配、质量、可用性）

兼容原则：
- 新字段仅追加，不破坏旧字段语义。
- 新参数默认关闭，不影响现有 caller 行为。
