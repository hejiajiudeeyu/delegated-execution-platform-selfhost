# 当前实现状态（MVP v0.1）

> 英文版：./current-implementation-status.md
> 说明：中文文档为准。

本文件用于区分三类事项：
- 已完成（当前仓库已落地）
- 本次要实现（进入 v0.1 开发）
- 后续开发（明确不在 v0.1）

更新时间：2026-03-16

## 1) 已完成（架构与规范文档）

- [x] 项目总览与三方职责说明（Caller / Responder / Platform）
- [x] MVP 架构基线文档（状态机、幂等、错误码、token、签名、超时分层）
- [x] 平台 API v0.1 文档（目录、token、请求事件 ACK、心跳、metrics）
- [x] 集成手册（Caller 流程、Responder 流程、平台目录分发流程）
- [x] 目录手工导入模板（单条 JSON + 批量 NDJSON）
- [x] 数据采集方案文档（观测/运维/演进）
- [x] ACK 机制文档化（Responder 先 ACK，再执行，再通过传输通道回包）
- [x] responder heartbeat 文档化（可用性 `healthy/degraded/offline`）
- [x] 决策记录：MVP 不做检索能力开发，仅遍历 + 分类过滤
- [x] 安全模型补全（Token 传输安全、API Key 生命周期、公钥轮换协议）
- [x] 监控告警最小方案（healthz、告警规则、告警通道）
- [x] 最小人工复核通道（DISPUTED 状态流程与证据留存）
- [x] responder 信息变更流程（可变更字段、变更方式、公钥轮换联动）
- [x] 目标用户画像与 FAQ
- [x] 测试策略（单元/集成/负载/混沌测试清单）
- [x] Schema 演进与版本升级策略
- [x] 外部依赖风险清单
- [x] README 精简为接口清单表
- [x] 超时与 Token 参数校准（ack_deadline_s=120, token_ttl_seconds=300）
- [x] 能力声明模板机制（Capability Templates）：解决 Caller / Responder 输入输出信息不对称
- [x] foxlab.text.classifier.v1 模板文件（input/output schema、示例合约/结果、README）
- [x] owlworks.data.extractor.v1 模板文件（input/output schema、示例合约/结果、README）
- [x] 目录条目新增 `template_ref` 字段，关联能力声明模板目录
- [x] 集成手册补充模板拉取流程（渐进式披露）与 responder 模板维护规范
- [x] Monorepo 脚手架落地（`apps/platform-api`、`apps/caller-controller`、`apps/responder-controller`、`docker-compose.yml`、`Makefile`）
- [x] Platform API 最小可运行控制面端点骨架（内存态，便于联调）
- [x] Caller Controller 内部请求状态接口骨架（含超时决策接口）
- [x] Responder Controller 任务队列骨架（priority/FIFO + lease_ttl 基础语义）
- [x] 测试骨架落地（unit/integration/e2e + mocks + flow report）
- [x] 测试可视化页面（`site/protocol-playground.html`，支持按 `flow_step_id` 高亮）
- [x] docker compose 真实进程冒烟联调脚本（`tests/smoke/compose-smoke.mjs`）
- [x] `ops-console` 本地轻会话（passphrase 解锁 + 短期 session）
- [x] 本地加密 secret store（`~/.delexec/secrets.enc.json`，`scrypt + AES-256-GCM`）
- [x] `platform-console-gateway` 本地 operator gateway（浏览器不再直接持有 admin key）
- [x] Caller Skill Adapter 首版（`apps/caller-skill-adapter`）
- [x] 官方 example hotline、本地 self-call 路径与 coding-agent bootstrap
- [x] 首版外部邮件 transport adapter（EmailEngine / Gmail API）

说明：当前已具备三端可启动脚手架；并已补齐一版已实现基线联调闭环、协议参考控制面最小 RBAC、Caller 验签信任链修正。

## 2) 本次要实现（进入 v0.1 开发）

说明：
- 本节聚焦 `L0 local transport` 可闭环能力。
- 任何依赖外部 transport、在线提交 onboarding、目录快照/增量、人工复核流程的事项，都放入后续开发。

## 2.1 服务端（Protocol Control Plane）
- [x] API Key 鉴权中间件（`user_id + role_scopes`，含 responder 侧资源归属校验）
- [x] 用户主体注册与 API Key 签发流程（当前实现默认 caller；responder 使用 bootstrap 资源用于联调）
- [x] `GET /v2/hotlines`（目录查询，支持 `status/availability_status`）
- [x] `POST /v1/tokens/task`（签发 task token）
- [x] `POST /v1/tokens/introspect`（当前实现要求 responder 资源归属）
- [x] `POST /v1/requests/{request_id}/delivery-meta`（Caller 单次拉取投递元数据）
- [x] `POST /v1/requests/{request_id}/ack`（Responder ACK 事件）
- [x] `GET /v1/requests/{request_id}/events`（Caller 事件轮询）
- [x] `POST /v2/responders/{responder_id}/heartbeat`（Responder 心跳）
- [x] `POST /v1/metrics/events`（事件上报）
- [x] `GET /v1/metrics/summary`（最小聚合查询）
- [x] 服务端存储落地 PostgreSQL（schema + migration）

## 2.2 Caller 端（Caller Controller Skill）
- [x] 目录遍历/分类过滤选择 responder
- [x] 任务合约生成（含 `request_id`）
- [x] 申请 token 并写入本地 request record
- [x] 申请 delivery-meta 并使用单次 transport endpoint 投递请求
- [x] ACK 事件轮询与 `ack_deadline` 超时处理
- [x] Caller Controller `soft_timeout` 继续等待确认（默认询问 Caller Agent）
- [x] Caller Controller `hard_timeout` 自动终态（停止本地等待，不依赖远端 kill）
- [x] Caller Agent 轮询 Caller Controller 内部接口（`GET /controller/requests/{request_id}`）
- [x] Caller Agent 提交超时决策到 Caller Controller（`POST /controller/requests/{request_id}/timeout-decision`）
- [x] 验签 + schema 校验 + 最小验收
- [x] 状态机与幂等状态落库
- [x] Caller 指标上报
- [x] 结果验签基于预绑定 `expected_signer_public_key_pem`，不信任结果包自带公钥
- [x] `POST /controller/requests/{request_id}/dispatch`（L0 local transport 联调入口）

## 2.3 Responder 端（Responder Template）
- [x] token 校验（当前实现统一走平台 introspect）
- [x] 护栏检查（超时/任务类型）
- [x] `request_id` 幂等去重与结果回放
- [x] 校验通过后入队并发 ACK，再执行任务
- [x] 任务队列（priority/FIFO + lease_ttl）
- [x] 执行器接口 + 至少 1 个示例执行器
- [x] 结果包签名与同线程/同请求语义回传
- [x] Responder 心跳周期上报
- [x] Responder 指标上报
- [x] `POST /controller/inbox/pull`（L0 local transport 拉取入口）
- [x] 支持注入平台 bootstrap signer，保证 Caller/Responder 验签信任链一致

## 2.4 E2E 验收（必须跑通）
- [x] 用例 A：成功（`L0 local transport` 联调）
- [x] 用例 B：超时（`L0 local transport` 联调）
- [x] 用例 C：token 过期（`L0 local transport` 联调）
- [x] 用例 D：输出不合规（`L0 local transport` 联调）
- [x] 用例 E：签名被篡改后进入 `UNVERIFIED`

## 2.5 测试策略
- **单元测试**：
  - [x] 合约 schema 校验（必填字段、类型、版本兼容）
  - [x] token claims 校验（aud/sub/request_id/hotline_id/exp）
  - [x] Ed25519 签名生成与验签
  - [x] 状态机迁移逻辑（合法迁移路径与非法迁移拒绝）
  - [x] 流程步骤映射完整性（E2E `flow_step_id` 对齐时序图标签）
  - [x] 错误码映射与 retryable 标记
- **集成测试**：
  - [x] 传输通道替身收发（发送任务 -> 回包轮询 -> request_id 过滤）
  - [x] PostgreSQL CRUD（compose 冒烟脚本内执行最小建表/写入/查询/清理）
- [x] introspect 端到端（签发 token -> introspect 校验 -> 过期后校验失败）
- [x] 心跳与可用性状态联动（heartbeat -> healthy/degraded/offline 判定）
- [x] 平台 responder 侧 RBAC（`responder_id/hotline_id` 资源归属）
- **负载测试（后续）**：
  - [ ] Responder 心跳并发（模拟 N 个 responder 同时心跳）
  - [ ] introspect 并发（验证 P99 < 200ms 目标）
  - [ ] 目录查询并发
- **混沌测试（后续）**：
  - [ ] 传输延迟模拟（验证超时分层与状态迁移）
  - [ ] 平台重启（验证状态持久化与恢复）
  - [ ] Responder 断连（验证 degraded/offline 判定时效性）

## 2.6 当前已落地测试能力（2026-03-06）

- [x] `vitest` 测试基线（unit/integration/e2e）
- [x] TUI 反馈（Vitest 默认终端输出）
- [x] Web UI 反馈（`site/protocol-playground.html`）
- [x] 流程步骤映射报告（`tests/reports/latest.json`）
- [x] 测试 mock 组件（platform/email/clock）
- [x] `L0 local transport` 真实联调装配（caller dispatch -> responder pull）

## 3) 后续开发（不在 v0.1）

- [x] `POST /v2/hotlines`（正式 responder/hotline onboarding 提交 API）
- [x] 目录导入流程最小版（平台 onboarding API + 版本记录 + responder/hotline 双审批）
- [ ] `POST /v1/requests/{request_id}/sent`（Caller 发送确认事件，区分"未发出"与"已发出未收 ACK"）
- [x] `POST /v1/requests/{request_id}/events` 最小完成态事件（`COMPLETED/FAILED`，用于提升完成率/时延观测）
- [x] `GET /v2/hotlines/{hotline_id}`（目录详情接口，实现轻列表 + 详情分离）
- [ ] token claims 增加 `caller_route_hash`，responder 侧做 return-route + claims 双因素校验
- [ ] 检索增强（联想检索、模糊搜索、领域策略、候选筛选）
- [ ] 目录快照/增量接口（`/snapshot`、`/changes`）
- [x] `POST /v2/admin/hotlines/{hotline_id}/review-tests` + `GET /v1/admin/review-tests*`（隐藏审核测试最小链路）
- [ ] 其他 Caller / Responder 外部 transport adapter（Email MCP / SMTP bridge / HTTP Webhook 的进一步扩展）
- [ ] 实时事件推送（SSE/WebSocket），替代轮询
- [ ] 请求进度事件上报（`POST /v1/requests/{request_id}/events`，`RUNNING/PROGRESS`）
- [ ] Caller Agent 与 Remote Hotline 的多轮会话语义（`session_id/turn_id`、会话级 token、等待态状态机）
- [ ] 完整人工复核流程（`DISPUTED` 全流程）
- [ ] 更细粒度的候选筛选与解释字段
- [ ] 多租户调度扩展（`tenant_quota` 等）
- [ ] API key 轮换 / 吊销 / 公钥轮换窗口
- [ ] metrics 聚合查询、告警规则与仪表盘
- [ ] 高级风控（异常流量/滥用检测）

## 4) 冻结决策（当前版本）

- [x] 传输抽象：`Transport Adapter`；当前联调实现为 `L0 local transport`，首版外部通道已实现 `relay_http`、`emailengine`、`gmail`
- [x] 本地控制台安全基线：`ops-console` 与 `platform-console` 采用本地 passphrase + encrypted secret store；platform admin 走本地 gateway 代理
- [x] 平台定位：协议控制面，不转发任务正文
- [x] 目录方式：正式 onboarding API + 查询 API + 双审批
- [x] ACK 机制：Responder 确认执行后先走服务端 ACK
- [x] 心跳机制：Responder 周期心跳，目录暴露可用性状态
- [x] 检索策略：MVP 不实现搜索引擎能力
- [x] token 校验模式：Responder 统一走在线 introspect
- [x] 请求事件范围：v0.1 实现 `ACKED` + `COMPLETED/FAILED` 观测事件；`RUNNING/PROGRESS` 仍不在范围内
- [x] 目录导入策略：按需即时导入
- [x] 服务端存储：PostgreSQL
- [x] 数据采集范围：以聚合指标和元数据为主，默认不采集正文
- [x] responder 不维护 hotline 列表，平台导入时建立 responder-hotline 关联
- [x] API 鉴权方式：API Key
- [x] 目录提交流程：`POST /v2/hotlines` + admin 双审批 + 可选隐藏审核测试
- [x] 主体接入方式：用户先注册并获得 caller 角色，responder 角色由 remote hotline onboarding/导入后激活
- [x] transport 投递观测窗口：delivery_observation_window_s=60
- [x] introspect 性能目标：P99 < 200ms，缓存 TTL=30s
- [x] 能力声明模板存储：Git 仓库 `docs/templates/hotlines/{hotline_id}/`，后续可迁移至独立存储
- [x] 能力声明模板下发：Caller 统一通过平台 API `GET /v2/hotlines/{hotline_id}/template-bundle`

## 5) 待你确认（参数冻结）

参数建议见：
- `defaults-v0.1.md`

确认结果（已冻结，可开工）：
- [x] `ack_deadline_s=120`
- [x] `token_ttl_seconds=300`
- [x] `soft_timeout_s=90 / hard_timeout_s=300`
- [x] `max_retry_attempts=2` 与 `retry_backoff=exponential+jitter`
- [x] `heartbeat_interval_s=30 / degraded_threshold_s=90 / offline_threshold_s=180`
- [x] `result_signature_algorithm=Ed25519`
- [x] `catalog_default_availability_filter=healthy`
- [x] `mvp_display_metrics=call_volume,success_rate,timeout_rate,schema_compliance_rate,p95_exec_ms`
