协议控制平面API v0.1（MVP）

> 英文版：[platform-api-v0.1.md](platform-api-v0.1.md)
> 说明：中文文档为准。

# 协议控制平面API v0.1（MVP）

本文档定义了`Remote Hotline Protocol`的最小控制面API：身份、目录、模板下发、token、请求事件、指标。  
当前仓库已实现的联调模式为`L0本地传输`；控制面只依赖`Transport Adapter`抽象，`Email MCP`只是外部通信模式之一。这里描述的是协议参考控制面，而不是要求所有实现共享同一个集中式托管亚马逊。

## 1. 规划边界

- 平台职责：目录索引、授权签发、指标聚合。
- 职责非：任务主体代理转发、Responder执行编排、长期托管。
- 超时边界：平台不提供“远端执行进程kill”语义；Caller侧超时仅影响Caller本地等待状态。
- 版本：策略`/v1`路径版本+刀片光纤兼容扩展。

## 2. 通用约定

## 2.1 内容类型
- 请求与响应均使用 `application/json;字符集=utf-8`

## 2.2 鉴权（v0.1 冻结）
- 统一使用`API Key`鉴权。
- 建议请求头：`Authorization: Bearer <API_KEY>`。
- API Key 绑定`user_id + role_scopes`，服务端按scope与资源归属做鉴权（默认`caller`，当对应远程热线完成onboarding/导入后可激活`responder`）。

目前实现补充：
- `POST /v1/tokens/task`、`POST /v1/requests/{request_id}/delivery-meta`：要求 `caller` 身份。
- `POST /v1/tokens/introspect`、`POST /v1/requests/{request_id}/ack`、`POST /v2/responders/{responder_id}/heartbeat`：要求`responder`身份，且命中`responder_id/hotline_id`资源归属。

## 2.3 时间、ID与身份映射
- 时间：ISO8601 UTC（如`2026-03-02T12:00:00Z`）
- `request_id`：UUIDv7 推荐
- 分页：使用 `next_page_token`
- `user_id`：用户主体标识（注册后默认具备`caller`）
- `caller_id`：v0.1默认与`user_id`同值映射
- `responder_id`：首次远程热线加入审核通过后创建并绑定`owner_user_id`
- `owner_user_id`：远程热线提交人与资源归属主键（`owner_user_id -> responder_id -> hotline_id`）

## 2.4 通用错误响应

所有 HTTP 错误响应均使用格式格式：

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
- `code`（string）：机器的错误码
- `message`（string）：人类的错误描述
- `retryable`（boolean）：是否建议客户端自动重试

`可重试`规则：
- `AUTH_*`：`false`（权限/权限问题不可自动重试）
- `CONTRACT_*`：`false`（请求格式错误需修改）
- `CATALOG_*` / `REQUEST_NOT_FOUND` / `RESPONDER_NOT_FOUND` / `USER_NOT_FOUND`：`false`
- `*_BINDING_MISMATCH`：`false`
- `PLATFORM_NOT_CONFIGURED` / `TRANSPORT_NOT_CONFIGURED`：`false`（配置问题）
- `*_INTERNAL_ERROR` / 500 错误：`true`（临时故障可重试）
- `RESULT_NOT_READY`：`true`（结果尚未就绪，可稍后重试）

实现口径：
- 中心错误码定位于`@delexec/contracts`，服务端填写错误响应默认以该樱桃坐标推导`可重试`。
- 新增标准错误码时，应先更新中心错误，再补充服务逻辑与文档。

附加字段可出现在`error`对象同级中，例如：

```json
{
  "error": { "code": "not_found", "message": "no matching route", "retryable": false },
  "path": "/v1/unknown"
}
```

错误码划分范围：
- `AUTH_*`
- `合同_*`
- `执行_*`
- `结果_*`
- `交付_*`
- `模板_*`
- `平台_*`
- 以及当前实现已使用的`CATALOG_*`、`REQUEST_*`、`RESPONDER_*`、`USER_*`、`HOTLINE_*`、`TRANSPORT_*`、`SIGNER_*`、`TASK_*`、`CALLER_*`、`RELAY_*`、`OPS_*`

当前实现使用的`AUTH_*`错误码：
- `AUTH_UNAUTHORIZED`：API Key无效或失败
- `AUTH_TOKEN_INVALID`：任务令牌解析或签名验证失败
- `AUTH_TOKEN_EXPIRED`：任务令牌已过期
- `AUTH_RESOURCE_FORBIDDEN`：范围正确但资源归属不匹配

## 2.5 用户注册接口

- 方法：`POST /v1/users/register`
- 用途：创建用户主体，默认激活`caller`范围，并签发API Key

请求字段（Body）：
- `contact_email`（当前实现必填；兼容旧字段`email`）
- `display_name`（文档保留，当前实现未强制）
- `组织名称`（可选）
- `区域设置`（任选）

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
- 注册完成不会直接激活`responder`；需对应远程热线onboarding/导入后激活。

## 3.目录API

## 3.1 查询热线

- 方法：`GET /v2/hotlines`
- 用途： Caller搜索可调用热线

查询参数：
- `状态`（可选，`默认启用`）
- `availability_status`（任选，`健康|降级|离线`）
- `任务类型`（可选）
- `能力`（可选）
- `标签`（任选）

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

### 3.1.1 Caller筛选最小间隙集（冷冻）

`GET /v2/hotlines`（以及后续`GET /v1/catalog/search`）应保证以下字段可用：

- 身份：`hotline_id`、`responder_id`
- 显示：`display_name`
- 可用性：`status`、`availability_status`、`last_heartbeat_at`
- 验签材料：`responder_public_key_pem`（北极轮换窗口可返回 `responder_public_keys_pem[]`）
- 合约构建入口：`template_ref`

以下字段属于推荐增强，不是L0必备：
- `功能[]`、`supported_task_types[]`、`版本`
- `sla_hint.*`、`eta_hint.*`

`GET /v1/catalog/search` 额外字段（仅搜索模式）：
- `得分`、`比赛原因`、`得分明细`

说明（可扩展性）：
- 当前建议优先使用遍历/分类过滤。
- `task_delivery` / `result_delivery` 不在目录批量接口返回；Caller需在 token 签发后按 `request_id` 单次申请投递元数据。
- `task_delivery.address` 的值只保证是可投递的不透明传输端点，不保证是邮箱地址、URL 或固定 URI 形式。
- 当前实现会在目录列表中直接返回`responder_public_key_pem`，提供Caller在本地创建请求记录与验签时绑定信任根。
- 后续可新增 `GET /v1/catalog/search`，支持关联、模糊匹配与领域策略。
- 为保持兼容，`GET /v2/hotlines`长期保留，不因搜索增强而下线。

## 3.2 分代理注册/目录提交

- 方法：`POST /v2/hotlines`
- 用途：正式提交Responder/热线入职草稿
- 调用方：`Caller` 或 `Responder`

目前实现采用双轴状态：
- 审核状态：`review_status = 待定 |已批准 |被拒绝`
- 运行状态：`status =enabled |禁用`

公开目录与远程调用仅在以下条件同时满足时成立：
- `responder.review_status=已批准`
- `hotline.review_status=已批准`
- `responder.status=已启用`
- `hotline.status=启用`

第一个Responder提交时间：
- 自动创建Responder身份和ResponderAPI密钥
- `responder.review_status=pending`
- `hotline.review_status=pending`
- `responder.status=已禁用`
- `hotline.status=已禁用`

201 响应最小字段：
- `Responder ID`
- `hotline_id`
- `Responder评论状态`
- `hotline_review_status`
- `Responder状态`
- `热线状态`
- `目录可见性`
- `提交版本`
- `responder_api_key`（仅首次创建Responder时返回）

兼容路径：
- `POST /v2/responders/register` 仍保留一段兼容，但内部转调正式上线核心。

## 3.3 获取热线 详情

- 方法：`GET /v2/hotlines/{hotline_id}`
- 用途：返回目录详情与最近一次提交流水摘要

访问规则：
- 公开状态 hotline：返回 sanitize 后的公开详情
- `pending/rejected/disabled`：仅所有者或管理员可见完整详情

所有者/管理员视角可见：
- 当前 `review_status/status`
- `提交版本`
- 最近审核备注
- 最近一次`review_test`摘要
- 最近提交有效载荷快照

## 3.4 获取能力声明模板包

- 方法：`GET /v2/hotlines/{hotline_id}/template-bundle`
- 用途：Caller按目录边境中的`template_ref`拉取模板，构造完成输入输出

路径参数：
- `hotline_id`

查询参数：
- `template_ref`（可选，建议透传目录项值；服务端用于一致性校验）

请求头（可选，后续增强）：
- `If​​-None-Match: "<etag>"`（当前未实现，工件）

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

L0最小要求：
- `输入模式`
- `输出模式`

任选增强字段：
- `示例合同`
- `示例结果`
- `自述文件_markdown`
- `模板版本`
- `ETag`

状态码约定：
- `200`：返回模板包
- `304`：`ETag` 命中，消耗重复下发（后续增强，当前未实现）
- `404`：`模板_未找到`
- `409`：`TEMPLATE_REF_MISMATCH`（确定`template_ref`与目录当前绑定交互）

## 3.5 管理员审核测试（隐藏审核测试）

- 方法：`POST /v2/admin/hotlines/{hotline_id}/review-tests`
- 用途：管理员对待审核子机构发起隐藏审核测试
- 当前自动化范围：仅支持平台可直连的 `local://` / 中继支持的任务交付

配套接口：
- `GET /v1/admin/review-tests`
- `GET /v1/admin/review-tests/{request_id}`

目的地：
- 使用平台保留合成Caller身份创建隐藏请求
- 复用真实token/delivery-meta/responder执行/结果验证主链
- 结果仅进入审核测试记录，不进入公开目录
- 审查测试通过不会自动触发批准

## 3.6 管理员审查/运行时操作

管理员动作：
- `POST /v2/admin/responders/{responder_id}/approve|reject|enable|disable`
- `POST /v2/admin/hotlines/{hotline_id}/approve|reject|enable|disable`

目的地：
- `approve`：设置`review_status=approved`，并在第一次时默认同步`status=enabled`
- `reject`：设置 `review_status=rejected` 且 `status=disabled`
- `disable`：只改`status=disabled`
- `enable`：仅允许对已`approved`的Responder/热线恢复`status=enabled`

可见性规则：
- Responder被拒绝/禁用时，其所有热线保持 `catalog_visibility=hidden`
- 单个热线被拒绝/禁用仅影响该热线

## 4. 代币API

## 4.1 任务令牌签发

- 方法：`POST /v1/tokens/task`
- 用途： Caller为单次任务申请短期授权

请求字段（Body）：
- `request_id`
- `Responder ID`
- `hotline_id`

说明：
- `caller_id` 通过 API Key 绑定身份推导，不要求调用方显式形成。
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

## 4.2 代币内省（v0.1 必做）

- 方法：`POST /v1/tokens/introspect`
- 用途：Responder在线查询代币是否有效（v0.1 统一校验模式）

请求字段（Body）：
- `任务令牌`

鉴权约束：
- 调用方需具备`responder`范围。
- 平台需结算调用方是否命中资源归属（`owner_user_id -> responder_id -> hotline_id`）。
- 当前实现的Responder权限失败返回：`AUTH_SCOPE_FORBIDDEN` 或 `AUTH_RESOURCE_FORBIDDEN`。

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

## 5. 指标API

## 5.1 事件上报

- 方法：`POST /v1/metrics/events`
- 用途： Caller/Responder提交最小装船事件

说明：
- 不属于L0闭环的API。
- L0可以先实现最小事件接收；聚合分析属于后续增强。

请求字段（Body）：
- `来源`：`Caller|Responder`
- `event_type`：如`request_succeeded|request_timeout|schema_invalid|signature_invalid`
- `request_id`（任选）
- `时间戳`（可选）
- `payload`（可选，扩展）

扩展字段（可选）：
- `Caller ID`
- `Responder ID`
- `hotline_id`

鉴权约束：
- 调用方需通过认证（`requireAuth`）。
- 当前实现不按 `source` 区分范围；后续版本将增加 `source=caller` 需Caller范围、`source=responder` 需Responder范围的校验。

202 响应示例：
```json
{
  "accepted": true,
  "event": { "source": "caller", "event_type": "caller.request.dispatched", "request_id": "..." }
}
```

## 5.2 聚合查询

- 方法：`GET /v1/metrics/summary`
- 用途：提供协议对接与实现对照所需的聚合硬指标

说明：
- 不属于L0最小闭环。
- 当前实现返回最小聚合结构，按事件类型计数。后续版本将扩展为完整的聚合指标窗口。

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

## 6. 请求协调API（delivery-meta/ACK/状态事件）

该组接口用于请求投递协调与轻量状态回传，避免Caller无效等待。  
注意：只传事件摘要，不传任务正文与结果正文。
v0.1 实现范围：`delivery-meta` + `ACKED` + Responder态落地事件（`COMPLETED/FAILED`）。

说明：
- Caller Controller 与 Caller Agent 之间的内部接口（如 `GET /controller/requests/{request_id}`、`POST /controller/requests/{request_id}/timeout-decision`）属于实现内部接口，不属于平台外部 API。

## 6.1 Caller申请投递元数据（delivery-meta）

- 方法：`POST /v1/requests/{request_id}/delivery-meta`
- 用途：Caller在代币签发后，按单次请求拉取目标Responder的投递元数据

路径参数：
- `request_id`

请求字段（Body）：
- `responder_id`（必填）
- `hotline_id`（必填）
- `task_token`（可选，建议为声明交叉校验建立建议）

鉴权约束：
- 调用方需具备`caller`范围。
- 平台审核调用方与 `request_id` 的归属（`caller_id` 时间表）以及 `responder_id/hotline_id` 一致性。

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
- `403/409`：与 token/目录绑定交互

## 6.2 ResponderACK（已接单）

- 方法：`POST /v1/requests/{request_id}/ack`
- 用途：Responder通过快速校验并开始处理后，确认“已接单”

路径参数：
- `request_id`

请求字段（Body）：
- `responder_id`（必填）
- `hotline_id`（必填）
- `eta_hint_s`（任选）

合同条款：
- 对同一`request_id` 幂等。
- 平台审核调用方具备 `responder` 范围且 `owner_user_id -> responder_id -> hotline_id` 绑定命中。
- 可验证是否与已签发令牌的 `aud/hotline_id` 字符。

202 响应示例：
```json
{
  "accepted": true,
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41"
}
```

## 6.3 Responder状态事件上报

- 方法：`POST /v1/requests/{request_id}/events`
- 用途：Responder上报轻量状态事件；v0.1 目前实现支持 `COMPLETED/FAILED`，`RUNNING/PROGRESS` 仍为后续扩展。

请求字段（Body）：
- `Responder ID`
- `hotline_id`
- `event_type`（v0.1 当前实现：`FAILED|COMPLETED`；后续可扩展`RUNNING|PROGRESS`）
- `finished_at`（任选，ISO8601 UTC；未提供则服务端落库时间同等）
- `status`（任选，建议`ok|error`）
- `error_code`（可选，仅失败时建议带）
- `progress`（任选，后续扩展）
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

## 6.4 Caller查询请求事件

- 方法：`GET /v1/requests/{request_id}/events`
- 用途：完成Caller轮询ACK/态事件，减少盲点等并获得控制面装船信息

查询参数（后续增强，当前未实现）：
- “since”（任选，后续增量查询）
- `limit`（任选，后续分页研发）

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

## 7. Responder心跳API

心跳用于反映Responder在线状态与基础负载，而不是替代单请求ACK。

## 7.1 上报心跳

- 方法：`POST /v2/responders/{responder_id}/heartbeat`
- 用途：Responder周期性上报在线状态

路径参数：
- `Responder ID`

请求字段（Body）：
- `status`（任选，默认`healthy`）
- `队列深度`（任选）
- `est_exec_p95_s`（任选）

鉴权约束：
- 调用方需具备`responder`范围。
- 平台需验证 `owner_user_id -> responder_id` 绑定关系。

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

- `心跳间隔 = 30`
- `degraded_threshold_s = 90`
- `离线阈值 = 180`

状态规则：
- `健康`：`现在 - last_heartbeat_at <= 90s`
- `降级`：`90s < 现在 - last_heartbeat_at <= 180s`
- `offline`：`现在 - last_heartbeat_at > 180s`

## 8.手工导入目录模板

MVP目录注册采用手工导入，模板文件见：
- `docs/templates/catalog-hotline.template.json`（单条模板）
- `docs/templates/catalog-hotlines.import.template.ndjson`（批量模板）

能力声明模板（参见 `architecture.md` §4.5）：
- 每个热线在 `docs/templates/hotlines/{hotline_id}/` 下维护 `input.schema.json`、`output.schema.json`、`example-contract.json`、`example-result.json`、`README.md`。
- 目录入口通过 `template_ref` 字段绑定模板，Caller选定热线后通过 `GET /v2/hotlines/{hotline_id}/template-bundle` 拉取模板包。

建议导入流程：
本节属于 L0 后入职规划，而不是 v0.1 L0 必要能力。

后续若恢复在线/半在线onboarding，建议流程为：
1. 用户先调用 `POST /v1/users/register` 完成注册（默认 `caller`）。
2. 用户提交远程热线草案（提出 `owner_user_id`）。
3. 平台管理员在模板中填写/修改 `hotline_id/responder_id/capability/supported_task_types` 并建立关联。
4. 使用CLI执行校验与审核导入。
5. 首次导入成功后，平台激活该用户`responder`范围，并记录资源绑定关系。
6. 平台记录导入批次号与审计信息，并通过 `GET /v2/hotlines` 污染物核对。

## 9. 搜索强化架构（后续规划，不在v0.1实现）

本节属于post-L0 搜索增强规划，而不是 v0.1 L0 简单能力。

为支持增强搜索能力，建议提出以下查询参数/字段：
- `q`：自由文本查询
- `fuzzy`：模糊匹配开关
- `domain`：领域策略（如`法律|金融|生物医学`）
- `filter_profile`：筛选策略标识

建议建议以下施工领域：
- `分数`：综合相关性分
- `match_reasons`：命中原因（关键词、同义词、标签）
- `score_breakdown`：分项得分（文本匹配、质量、可用性）

兼容原则：
- 新字段仅追加，不破坏旧字段语义。
- 新参数默认关闭，不影响现有Caller行为。
