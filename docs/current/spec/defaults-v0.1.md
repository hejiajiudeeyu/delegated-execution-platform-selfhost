# Defaults v0.1（建议冻结参数）

用途：在编码前一次性冻结关键参数，避免 Caller 端、Responder 端、服务端实现分叉。

状态说明：
- `FROZEN`：已确认并冻结（v0.1）

更新时间：2026-03-05

补充约束（模式演进）：
- `L0-L3` 应被视为同一系统的可选运行模式，而不是四套不同协议实现。
- 模式切换只允许改变 controller 间通信拓扑、relay / mailbox / network 边界与 transport adapter 装配方式。
- 模式切换不得改变核心协议语义、请求/结果结构、状态机迁移规则、ACK 语义与幂等规则。

## 1) 请求与超时

| 参数 | 建议值 | 状态 | 说明 |
|---|---:|---|---|
| `ack_deadline_s` | `120` | FROZEN | Caller 发单后等待 ACK 的最大时长（含 transport 投递延迟） |
| `soft_timeout_s` | `90` | FROZEN | 软超时，触发告警或降级 |
| `hard_timeout_s` | `300` | FROZEN | 硬超时，Caller 终止等待并记超时 |
| `timeout_confirmation_mode` | `ask_by_default` | FROZEN | 达到 `soft_timeout_s` 时默认先询问 Caller Agent 是否继续等待 |
| `hard_timeout_auto_finalize` | `true` | FROZEN | 达到 `hard_timeout_s` 且未明确继续等待时自动终态 `TIMED_OUT` |
| `caller_controller_poll_interval_active_s` | `5` | FROZEN | Caller Agent 轮询 Controller 的活跃期间隔（前 30 秒） |
| `caller_controller_poll_interval_backoff_s` | `15` | FROZEN | Caller Agent 轮询 Controller 的退避间隔（30 秒后） |
| `max_retry_attempts` | `2` | FROZEN | 最大重试次数（总尝试数=3）。规划参数，当前未实现重试逻辑 |
| `retry_backoff` | `exponential + jitter` | FROZEN | 重试退避策略。规划参数，当前未实现 |
| `delivery_observation_window_s` | `60` | FROZEN | transport 投递观测窗口，用于超时分层计算。规划参数，当前未实现 |

## 2) Token 与安全

| 参数 | 建议值 | 状态 | 说明 |
|---|---:|---|---|
| `token_ttl_seconds` | `300` | FROZEN | 任务 token 有效期（当前实现默认 5 分钟） |
| `token_min_ttl_seconds` | `300` | FROZEN | v0.1 最短建议有效期 |
| `token_max_ttl_seconds` | `300` | FROZEN | v0.1 当前冻结为单一 TTL |
| `result_signature_algorithm` | `Ed25519` | FROZEN | 结果包签名算法 |
| `responder_token_validation_mode` | `online_introspect_required` | FROZEN | Responder 校验 token 统一走 `POST /v1/tokens/introspect` |
| `idempotency_window_hours` | `24` | FROZEN | `request_id` 去重窗口。规划参数，当前未实现显式窗口清理 |
| `introspect_sla_p99_ms` | `200` | FROZEN | introspect 接口 P99 延迟目标 |
| `introspect_cache_ttl_s` | `30` | FROZEN | introspect 结果缓存 TTL。规划参数，当前未实现缓存 |

## 3) 心跳与可用性

| 参数 | 建议值 | 状态 | 说明 |
|---|---:|---|---|
| `heartbeat_interval_s` | `30` | FROZEN | Responder 心跳上报间隔 |
| `degraded_threshold_s` | `90` | FROZEN | 超过该值进入 `degraded` |
| `offline_threshold_s` | `180` | FROZEN | 超过该值进入 `offline` |
| `catalog_health_cache_ttl_s` | `60` | FROZEN | Caller 读取健康状态缓存 TTL。规划参数，当前未实现 |

## 4) 目录与路由

| 参数 | 建议值 | 状态 | 说明 |
|---|---:|---|---|
| `catalog_cache_ttl_s` | `300` | FROZEN | Caller 目录缓存 TTL。规划参数，当前未实现 |
| `catalog_default_status_filter` | `enabled` | FROZEN | 默认过滤已启用条目 |
| `catalog_default_availability_filter` | `healthy` | FROZEN | 默认只选健康 responder |
| `routing_fallback_policy` | `retry_once_then_switch_responder` | FROZEN | ACK 超时后路由策略 |
| `catalog_import_mode` | `on_demand_immediate` | FROZEN | 目录按需即时导入 |
| `responder_hotline_binding_mode` | `platform_import_association` | FROZEN | hotline 与 responder 关系由平台导入时建立 |
| `template_delivery_mode` | `platform_api_bundle` | FROZEN | Caller 通过平台 API 拉取模板包，不直接读取仓库目录 |
| `catalog_expose_task_delivery_address` | `false` | FROZEN | 目录批量查询不返回 request-scoped `task_delivery/result_delivery` |
| `delivery_meta_mode` | `request_scoped` | FROZEN | 通过 `POST /v1/requests/{request_id}/delivery-meta` 单次下发 |
| `delivery_meta_ttl_seconds` | `300` | FROZEN | 投递元数据有效期（与 token TTL 对齐） |

## 5) 指标与展示

| 参数 | 建议值 | 状态 | 说明 |
|---|---:|---|---|
| `metrics_windows` | `24h,7d` | FROZEN | 默认指标窗口 |
| `mvp_display_metrics` | `call_volume,success_rate,timeout_rate,schema_compliance_rate,p95_exec_ms` | FROZEN | MVP 对外展示硬指标 |
| `caller_event_required` | `caller.request.dispatched,caller.request.acked,caller.request.succeeded,caller.request.timed_out,caller.request.unverified,caller.request.failed` | FROZEN | Caller 最小事件集 |
| `responder_event_required` | `responder.task.received,responder.task.rejected,responder.task.succeeded,responder.task.timed_out` | FROZEN | Responder 最小事件集 |

说明：
- `POST /v1/metrics/events` 建议在 L0 实现最小接收能力。
- `GET /v1/metrics/summary` 属于可延后增强，不阻塞 L0 协议闭环。

## 6) 版本与兼容

| 参数 | 建议值 | 状态 | 说明 |
|---|---:|---|---|
| `contract_version` | `0.1.0` | FROZEN | 合约版本 |
| `result_version` | `0.1.0` | FROZEN | 结果包版本 |
| `api_version_prefix` | `/v1` | FROZEN | 控制面 API 路径版本 |
| `compat_policy` | `additive-only` | FROZEN | 仅追加字段，不破坏旧语义 |
| `request_event_scope_v0_1` | `ACKED_completed_failed` | FROZEN | v0.1 实现 `ACKED` 与 Responder 完成态观测事件 `COMPLETED/FAILED`，不实现 `RUNNING/PROGRESS` |
| `platform_storage_backend` | `PostgreSQL` | FROZEN | 服务端主存储选型 |
| `api_auth_mode` | `api_key` | FROZEN | 控制面 API 鉴权方式 |
| `identity_onboarding_mode` | `register_caller_default_then_activate_responder_on_remote_hotline_onboarding` | FROZEN | 用户注册后默认 caller；responder 角色在 remote hotline onboarding/导入后激活 |
| `responder_identity_cardinality` | `one_responder_per_user` | FROZEN | v0.1 一个 user 仅绑定一个 responder_id |
| `catalog_submission_mode` | `platform_onboarding_api_with_dual_admin_review` | FROZEN | 当前通过 `POST /v2/hotlines` 提交 responder/hotline，上架前要求 responder 与 hotline 双审批 |

## 7) 核心参数确认结果

以下 8 项已确认并冻结（可直接进入实现）：
1. `ack_deadline_s=120`
2. `token_ttl_seconds=300`
3. `soft_timeout_s=90`, `hard_timeout_s=300`
4. `max_retry_attempts=2`, `retry_backoff=exponential+jitter`
5. `result_signature_algorithm=Ed25519`
6. `heartbeat_interval_s=30`, `degraded_threshold_s=90`, `offline_threshold_s=180`
7. `catalog_default_availability_filter=healthy`
8. `mvp_display_metrics=call_volume,success_rate,timeout_rate,schema_compliance_rate,p95_exec_ms`

补充实现决议：
- `responder_token_validation_mode=online_introspect_required`
- `request_event_scope_v0_1=ACKED_completed_failed`
- `catalog_import_mode=on_demand_immediate`
- `platform_storage_backend=PostgreSQL`
- `responder_hotline_binding_mode=platform_import_association`
- `catalog_expose_task_delivery_address=false`
- `delivery_meta_mode=request_scoped`
- `delivery_meta_ttl_seconds=300`
- `api_auth_mode=api_key`
- `identity_onboarding_mode=register_caller_default_then_activate_responder_on_remote_hotline_onboarding`
- `responder_identity_cardinality=one_responder_per_user`
- `catalog_submission_mode=platform_onboarding_api_with_dual_admin_review`

## 8) 本地配置覆盖

仓库根目录提供了 `.env.example`，只列出当前实现与 compose 联调中真实生效的环境变量。

建议覆盖项（示例）：
- `TOKEN_TTL_SECONDS=300`
- `BOOTSTRAP_RESPONDER_ID=responder_...`
- `BOOTSTRAP_HOTLINE_ID=hotline.namespace.v1`
- `BOOTSTRAP_TASK_DELIVERY_ADDRESS=local://relay/...`（responder task endpoint，platform 会在 `delivery-meta` 中映射为 `task_delivery.address`）
- `BOOTSTRAP_RESPONDER_API_KEY=...`
- `BOOTSTRAP_RESPONDER_PUBLIC_KEY_PEM=...`
- `BOOTSTRAP_RESPONDER_PRIVATE_KEY_PEM=...`
- `ACK_DEADLINE_S=120`
- `TIMEOUT_CONFIRMATION_MODE=ask_by_default|always_continue|always_finalize`
- `HARD_TIMEOUT_AUTO_FINALIZE=true|false`
- `CALLER_CONTROLLER_POLL_INTERVAL_ACTIVE_S=5`
- `CALLER_CONTROLLER_POLL_INTERVAL_BACKOFF_S=15`
- `PLATFORM_API_BASE_URL=http://platform-api:8080`
- `PLATFORM_API_KEY=...`
- `DATABASE_URL=postgresql://...`
- `SQLITE_DATABASE_PATH=./data/delexec.sqlite`
- `PORT=8080|8081|8082`
- `SERVICE_NAME=platform-api|caller-controller|responder-controller`
- `RESPONDER_ID=responder_...`
- `HOTLINE_IDS=hotline.a.v1,hotline.b.v1`
- `RESPONDER_SIGNING_PUBLIC_KEY_PEM=...`
- `RESPONDER_SIGNING_PRIVATE_KEY_PEM=...`
- `RESPONDER_MAX_HARD_TIMEOUT_S=300`
- `RESPONDER_ALLOWED_TASK_TYPES=extract,classify`
- `RESPONDER_HEARTBEAT_INTERVAL_MS=30000`

说明：
- 未设置时，行为以本文件冻结默认值为准。
- `PLATFORM_API_BASE_URL` / `PLATFORM_API_KEY` 当前由 Caller/Responder app 启动层读取，用于装配平台 client。
- `DATABASE_URL` 当前由 Platform/Caller/Responder app 启动层读取；若配置，则会自动执行 migration 并启用 PostgreSQL 状态快照持久化。
- `SQLITE_DATABASE_PATH` 当前由 Platform/Caller/Responder app 启动层读取；仅在未设置 `DATABASE_URL` 时生效，用于单机 SQLite 快照持久化。
- `BOOTSTRAP_*` 当前由 Platform app 启动层读取，用于固定 compose/本地联调时的第一组 bootstrap responder 身份。
- Responder 的 `RESPONDER_*` 变量当前只影响 app 启动层的运行时身份和签名 key 装配。
- `RESPONDER_MAX_HARD_TIMEOUT_S` / `RESPONDER_ALLOWED_TASK_TYPES` 当前由 Responder app 启动层读取，用于装配最小 guardrail。
- `RESPONDER_HEARTBEAT_INTERVAL_MS` 当前由 Responder app 启动层读取，用于启动心跳周期任务。
- 存储后端优先级：`DATABASE_URL` > `SQLITE_DATABASE_PATH`。
- 定位建议：`PostgreSQL` 作为默认/推荐后端；`SQLite` 仅作为单机部署、演示或本地开发的便利选项。
- `.env.example` 当前不包含尚未接入运行时的链路切换变量；例如 `TRANSPORT_MODE` 仍属于后续实现，不应提前伪装成已生效配置。
- 若实现侧采用配置文件（如 YAML/TOML），需保持与上述变量语义一致。
