# Remote Hotline Protocol 架构设计（MVP）

## 1. 范围与原则

### 1.1 MVP 目标
- 先用 `L0 local transport` 验证 `Remote Hotline Protocol` 闭环是否成立；外部通信保持为 `Transport Adapter` 抽象，`Email MCP` 只是候选实现之一。
- 平台只做最小控制面：目录、token、投递元数据、事件、指标聚合。
- Caller 仅处理输入输出，不承载 Responder 执行依赖。
- 任何特定产品层、分发层和垂直实现层都被视为协议上的上层实现，不纳入当前协议核心定义。

### 1.2 非目标
- 不做实时低延迟通道保证（MVP 默认按异步通信模型设计）。
- 不做与协议闭环无关的外围业务系统。
- 不做主观评价驱动的展示、打分或推荐体系。

### 1.3 关键设计原则
- 合约优先：所有交互可落地为结构化 JSON。
- 幂等优先：`request_id` 贯穿全链路。
- 可迁移优先：传输通道通过适配器抽象，与业务状态机解耦。
- 最小信任：短期 token + 结果签名，平台不托管长期密钥。
- 本地控制面最小暴露：console 前端不直接持有长期 API key，优先通过本地 session + encrypted secret store + gateway/supervisor 代理访问敏感能力。
- 模式解耦：`L0-L3` 的差异仅体现在 controller 间的通信拓扑与运行边界，不得改变核心协议语义、请求/结果结构、状态机迁移规则与幂等规则。

补充命名语义：
- 本协议中的 `Remote` 指执行边界与信任边界，而不是物理部署距离。
- 因此，单机 `L0 local transport`、局域网 `L2`、以及外部通道 `L3` 都可以是 `Remote Hotline Protocol` 的有效运行模式。

### 1.4 文档真相源与衍生物分层

为避免同一事实在多个文档中重复发明，本仓库采用“真相源 -> 规范层 -> 说明层”的文档分层。

- 真相源（runtime truth sources）
  - `apps/*/src/server.js`：运行时 API 行为、鉴权分支、状态迁移、实际返回结构
  - `tests/integration/*`、`tests/e2e/*`：运行时行为验证
  - `docs/templates/hotlines/*/*.json`：模板输入输出结构与示例
  - `tests/unit/schema-validation.test.js`：模板 schema 机械校验
- 原则级真相源（architecture truth source）
  - `architecture.md`：系统边界、角色职责、模式不变量、语义分层、版本与信任模型
- 规范层衍生物（normative derivatives）
  - `platform-api-v0.1.md`：对外 API 规范说明，必须贴合运行时真相源
  - `integration-playbook.md`：端到端接入与联调手册，必须贴合运行时真相源与架构不变量
  - `defaults-v0.1.md`：冻结默认参数，必须贴合实现与架构约束
- 说明层衍生物（descriptive derivatives）
  - `README.md` / `README.zh-CN.md`
  - `docs/current/diagrams/*`
  - `docs/current/testing/*`
  - `../status/current-implementation-status.md`

维护规则：

- 说明层文档不得自行发明接口字段、状态枚举、错误码和返回结构。
- 若规范层与运行时真相源冲突，先修正代码或测试，再回补规范层文档。
- 若图示与规范层冲突，以规范层为准，并在同一变更中修图。
- 参考图：`../diagrams/doc-truth-source-map.md`

## 2. 系统边界与组件

## 2.1 角色
- Caller
- Responder
- 平台（Platform）
- 可选上层角色：目录维护方、集成协调方

## 2.1A 术语映射（协议层 vs 参考实现层）

- `Caller Agent`：Caller 侧本地智能体；在用户叙事中可等价理解为 `Local Agent`。
- `Remote Hotline`：Responder 发布并远程执行的能力单元，由 `responder_id + hotline_id` 标识。
- `Responder`：Remote Hotline 的发布者 / 维护者 / 资源归属主体。
- `Caller Controller`、`Responder Controller`：本仓库中的参考实现组件，不增加新的协议角色。

补充约定：
- 面向协议读者时，优先使用 `Caller Agent (Local Agent)` 与 `Remote Hotline`。
- 面向本仓库实现时，再使用 `Caller Controller`、`Responder Controller` 等组件名称。
- 更完整的迁移建议见 `../../planned/roadmap/evolution-roadmap.md`。

## 2.2 MVP 组件
- Caller-side Local Agent Runtime（当前参考实现：`Caller Controller`）
  - 任务拆解、合约构建、token 申请、请求投递、轮询、最小验收、状态管理。
- Remote Hotline Runtime Template（当前参考实现：`Responder Controller` + 执行器模板）
  - 收件、合约校验、token 校验、执行器调用、结果回传、幂等去重、指标上报。
- Platform Minimal Service
  - 目录注册/查询、模板包下发、token 签发/校验、投递元数据下发、请求事件接收、responder 心跳与可用性判定、指标接收/汇总。
- Transport Adapter Implementations
  - `Local Transport Adapter`（当前已实现）：单机内存队列；提供 `send / poll / ack / peek / health` 最小接口，作为 `L0` 运行模式的 controller 间通信通道。
  - 候选外部实现：`Email MCP Adapter`、`SMTP/API Email Bridge Adapter`、`HTTP/Webhook Adapter`。

## 2.2A 运行模式分层（后续演进约束）

为避免把不同通信方式做成多套协议实现，系统后续演进采用“同一内核、多种运行模式”策略。`L0-L3` 是部署/通信模式，不是四套业务协议。

- `L0: local runtime`
  - 单机并发运行；可包含多 worker、多 hotline 隔离。
  - controller 间通信可通过进程内队列、本机 IPC 或等价本地通道完成。
  - 当前仓库已实现最小内存队列版 `local transport`，用于 Caller/Responder/Platform 联调与 E2E。
- `L1: local virtual mailbox`
  - 单机运行，但引入本地虚拟中转站 / mailbox namespace，验证异步投递、线程语义与 ACL。
- `L2: LAN relay`
  - controller 跨局域网设备通信，引入节点注册、心跳、路由与断线恢复。
- `L3: external transport bridge`
  - 通过外部异步通道完成 controller 间通信；可实例化为 `Email MCP`、`SMTP/API email bridge`、`HTTP/Webhook relay` 等模式。

所有模式共享以下不变量：

- 统一 `request_id` / `thread_hint` / `message envelope` 语义。
- 统一 ACK、timeout、retry、idempotency 规则。
- 统一 caller / responder / platform 角色职责。
- 统一结果签名、错误码域和终态判定。

允许变化的只有：

- controller 间消息如何发送、投递、轮询、路由。
- relay / mailbox / network 边界的位置。
- 通信侧鉴权与节点发现的具体实现。

## 2.2B TransportAdapter 最小接口（模式切换边界）

为保证 `L0-L3` 只是运行模式切换而不是协议重写，controller 与通信层之间必须只通过统一的 `TransportAdapter` 交互。业务层不得直接感知“本地队列 / 虚拟邮箱 / LAN relay / MCP / Email / HTTP Webhook”的实现差异。

建议最小接口：

- `send(envelope)`：
  - 输入统一消息封装，至少包含 `message_id`, `request_id`, `thread_hint`, `from`, `to`, `message_type`, `payload`, `created_at`
  - 返回发送后的完整 message 对象（含生成的 `message_id` 和 `queued_at`）
- `poll({ limit, receiver })`：
  - 拉取当前 controller 可见的新消息
  - 返回 `{ items }` 数组
- `ack(message_id)`：
  - 确认某条传输消息已被本地消费，避免重复投递
  - 返回 `{ acked: true|false }`
- `peek({ thread_id })`（可选）：
  - 按线程或 request 维度查询调试视图，便于 playground / debugger / 运维排障
- `health()`：
  - 返回 transport 当前健康状态、队列深度、receiver 标识

统一消息封装建议字段：

- `message_id`：传输消息唯一标识
- `request_id`：业务幂等主键
- `thread_hint`：线程辅助标识
- `from` / `to`：controller 或 mailbox 身份
- `message_type`：如 `task_contract`, `result_package`, `transport_ack`
- `payload`：任务或结果正文
- `meta`：传输侧元数据（priority、ttl、attempt、trace_id）
- `created_at`

实现约束：

- `send/poll/ack` 语义在 `L0-L3` 中必须保持一致。
- transport 层允许“至少一次投递”，但 controller 必须基于 `request_id + message_type` 做幂等。
- transport 层不得重写业务 payload 结构，只能附加 `meta`。
- `health()` / `peek()` 可因模式能力不同而返回不同细节，但返回结构应保持兼容。

## 2.3 信任边界
- 平台信任自身签发 token，不信任任务内容正确性。
- Caller 信任平台签发能力，不默认信任 Responder 回传内容。
- Responder 信任 token 的授权边界，不信任外部输入参数合法性。

当前实现约束：
- Caller 验签必须使用平台目录/`delivery-meta` 绑定的 `responder_public_key_pem`，不得信任结果包自带公钥。
- Responder 侧敏感平台接口（如 `introspect`、`ack`、`heartbeat`）必须同时满足 `responder scope + responder_id/hotline_id` 资源归属。

## 3. 全局标识与版本策略

## 3.1 必备标识
- `request_id`：一次任务请求全局唯一（UUIDv7 推荐）。
- `user_id`：用户主体标识（注册后默认具备 caller 角色）。
- `caller_id`：Caller 角色标识（可与 `user_id` 同值映射）。
- `responder_id`：Responder 角色标识（由 remote hotline onboarding/导入后激活）。
- `hotline_id`：Responder 发布的 Remote Hotline 标识。
- `contract_version`：任务合约版本（如 `0.1.0`）。
- `result_version`：结果包版本（如 `0.1.0`）。

v0.1 映射约束（冻结）：
- `caller_id = user_id`（一对一）
- `responder_id` 在该用户首次 remote hotline onboarding 完成并导入成功时生成
- v0.1 默认一个 `user_id` 仅绑定一个 `responder_id`（后续版本再支持多 responder identity）

## 3.2 兼容策略
- 仅允许向后兼容新增字段（可选字段）。
- 主版本升级表示不兼容变更。
- v0.1 不引入多版本协商字段；若后续需要并存版本，再引入显式版本窗口声明。

## 3.3 Schema 演进与版本升级
- **数据库 Migration 工具**：建议使用语言生态主流工具（Node.js 用 `prisma migrate`，Python 用 `alembic`），schema 变更必须提交 PR 且附 migration 脚本。
- **非破坏性变更（v0.1.x）**：新增可选字段，不修改已有字段语义，接收方忽略未知字段。
- **L0 约束**：当前只冻结单一版本 `0.1.0`，不在 L0 基线中引入多版本路由、弃用通知或版本共存流程。
- **后续演进**：若进入多版本并存阶段，再单独定义弃用通知、迁移窗口和路由策略。

## 4. 合约与结果包规范（v0.1）

## 4.1 任务合约字段（最小集）
- `request_id`：幂等主键。
- `contract_version`
- `created_at`（ISO8601）
- `caller`：`caller_id`、`result_delivery`（可选；当前实现支持 `email|local|relay_http`，预留 `platform_inbox`）
- `responder`：`responder_id`、目标 `hotline_id`
- `task`：`task_type`、`input`、`output_schema`
- `constraints`：`soft_timeout_s`、`hard_timeout_s`
- `token`：短期 task token（JWT 或等价结构）
- `trace`：`thread_hint`、`source_run_id`

示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "contract_version": "0.1.0",
  "created_at": "2026-03-02T11:20:00Z",
  "caller": {
    "caller_id": "caller_acme",
    "result_delivery": {
      "kind": "local",
      "address": "caller-controller"
    }
  },
  "responder": {
    "responder_id": "responder_foxlab",
    "hotline_id": "foxlab.text.classifier.v1"
  },
  "task": {
    "task_type": "text_classification",
    "input": {
      "text": "The package arrived damaged."
    },
    "output_schema": {
      "type": "object",
      "required": ["label", "confidence"],
      "properties": {
        "label": { "type": "string" },
        "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
      }
    }
  },
  "constraints": {
    "soft_timeout_s": 90,
    "hard_timeout_s": 300
  },
  "token": "<TASK_TOKEN>",
  "trace": {
    "thread_hint": "croc-req-018f9d5e",
    "source_run_id": "run_caller_20260302_001"
  }
}
```

## 4.2 结果包字段（最小集）
- `request_id`
- `result_version`
- `responder_id`、`hotline_id`
- `status`（当前 wire-level 实现）：`ok | error`
- `output`：成功结果（需满足 `output_schema`）
- `error`：失败时提供 `code`、`message`、`retryable`
- `timing`：`accepted_at`、`finished_at`、`elapsed_ms`
- `usage`（可选）：实现自定义资源统计
- `signature_algorithm`、`signature_base64`：Responder 签名字段（防伪与去重）

说明：
- Responder 当前发送的是 wire-level 结果包：`status=ok|error`
- Caller Controller 在验签与 schema 校验后，再把本地请求状态归一化为 `SUCCEEDED | FAILED | UNVERIFIED | TIMED_OUT`
- 因此 `ok|error` 是传输层结果语义，`SUCCEEDED|FAILED|...` 是 Caller 本地状态机语义
- 结果包可携带 `signer_public_key_pem` 作为调试信息，但 Caller 的信任根必须来自目录或 `delivery-meta` 预绑定公钥。

示例：
```json
{
  "request_id": "018f9d5e-8bb2-7bc1-a4a3-1a8d9d8a2f41",
  "result_version": "0.1.0",
  "responder_id": "responder_foxlab",
  "hotline_id": "foxlab.text.classifier.v1",
  "status": "ok",
  "output": {
    "label": "refund_request",
    "confidence": 0.94
  },
  "timing": {
    "accepted_at": "2026-03-02T11:20:18Z",
    "finished_at": "2026-03-02T11:20:21Z",
    "elapsed_ms": 3100
  },
  "signature_algorithm": "Ed25519",
  "signature_base64": "responder_sig_v1_base64_placeholder"
}
```

## 4.3 线程与投递关联规则
- 协议主键永远使用 `request_id`；`thread_hint` 仅作同请求的关联辅助。
- L0 基线不规定邮件 subject、线程头或特定通道格式。
- 若某个 transport 需要额外线程语义，应由对应 adapter 文档补充，不反向定义协议核心字段。

## 4.4 错误结果包与投递元数据规则

### 错误结果包校验（与成功结果同级）
- 当前 wire-level 结果包中，`status=error` 时必须返回 `error.code/message/retryable`。
- Caller 对错误结果包执行与成功包一致的机械校验：`request_id`、`responder_id/hotline_id`、签名、版本。
- 校验通过的错误结果包可进入 Caller 后续决策循环（重试、切换候选或人工复核），而不是直接丢弃。

### 投递地址暴露策略（v0.1）
- `task_delivery` / `result_delivery` 不在目录批量查询中下发，避免被目录抓取滥用。
- `task_delivery.address` 是 opaque transport endpoint；实现可将其编码为本地 mailbox、relay URI、email 地址或其他 transport-specific 字符串。
- Caller 在获取 token 后，通过 `POST /v1/requests/{request_id}/delivery-meta` 单次获取双向路由与 `verification`。
- `delivery-meta` 与 `request_id + responder_id + hotline_id + caller_id` 绑定，过期后不可复用。

## 4.5 能力声明模板（Capability Templates）

### 目的
解决 Caller 与 Responder 间信息不对称问题：Caller 在选择 hotline 后，需要明确**应提供哪些输入**以及**将获得什么格式的输出**。模板机制通过结构化的 schema 和示例实现渐进式披露。

### 模板目录结构
每个已注册 hotline 在仓库中维护一组模板文件：

```
docs/templates/hotlines/{hotline_id}/
├── input.schema.json      # 输入 JSON Schema，定义 task.input 字段
├── output.schema.json     # 输出 JSON Schema，定义 task.output_schema
├── example-contract.json  # 完整合约示例
├── example-result.json    # 完整结果包示例
└── README.md              # 能力说明、标签集、约束、快速开始
```

### 目录关联
目录条目新增 `template_ref` 字段，作为该 hotline 模板语义绑定键：
```json
{
  "hotline_id": "foxlab.text.classifier.v1",
  "template_ref": "docs/templates/hotlines/foxlab.text.classifier.v1/",
  ...
}
```

### 渐进式披露流程
1. **浏览目录**：Caller 查询 `/v2/hotlines`，获得概要信息（description、capabilities、eta_hint 等）。
2. **选择 hotline**：Caller 确定目标 hotline 后，通过 `GET /v2/hotlines/{hotline_id}/template-bundle?template_ref=...` 获取模板包。
3. **构造合约**：Caller 参照 `input.schema.json` 填写 `task.input`，用 `output.schema.json` 设定 `task.output_schema`。
4. **参考示例**：`example-contract.json` 和 `example-result.json` 提供端到端的请求-响应样本。

### 模板维护规范
- 模板文件由 Responder 维护，通过 PR 提交更新。
- Schema 变更遵循合约版本策略（§3.2）：仅允许向后兼容新增字段。
- 平台在合并模板 PR 后自动更新目录的 `updated_at` 时间戳。
- MVP 阶段模板仍存储在 Git 仓库中，但对 Caller 统一通过平台 API 下发，不暴露仓库直读依赖。

## 5. Token 与签名模型

## 5.1 Task Token 必备 claims
- `iss`：platform issuer
- `aud`：目标 `responder_id`
- `sub`：`caller_id`
- `request_id`
- `hotline_id`
- `iat`、`exp`
- `jti`（唯一 token id）

## 5.2 校验规则
- Responder 必须校验 `aud/sub/request_id/hotline_id/exp`。
- v0.1 Responder 统一通过 `introspect` 在线校验 token。
- token 默认短效（当前冻结为 5 分钟，需覆盖单次 transport 投递与 ACK 观察窗口），超时拒绝执行。
- **introspect 性能目标**：P99 < 200ms。服务端建议对 introspect 加简单缓存（token hash -> 校验结果，TTL 30s），降低重复校验开销。
- **本地校验预留（v0.2）**：后续可支持 Responder 缓存平台公钥进行本地 JWT 验签，仅对高风险或异常请求 fallback 到在线 introspect。

## 5.3 结果签名
- Responder 使用私钥对结果包 canonical JSON 签名。
- Caller 通过目录中的 responder 公钥验证签名。
- 签名失败结果标记为 `UNVERIFIED`，不进入成功统计。

## 5.4 Token 传输安全
- 外部异步通道不保证端到端加密时，token 在传输中存在被截获的理论风险。
- MVP 接受此风险，依靠三重防护组合降低实际影响：
  1. **单次使用**：`jti` 全局唯一，Responder 通过 introspect 去重，同一 token 无法重放。
  2. **短时效**：token TTL 当前默认 5 分钟，攻击窗口极小。
  3. **request 绑定**：token claims 中绑定 `request_id/caller_id/responder_id/hotline_id`，无法挪用到其他请求。
- L0 `local transport` 不引入额外网络传输风险；上述风险主要针对后续外部 transport。

## 5.5 API Key 生命周期
- **签发**：用户主体注册成功后，平台签发 API Key（默认 `role_scopes={caller}`）。
- **L0 约束**：v0.1 只要求 key 能签发并用于 RBAC 鉴权，不把轮换、自助吊销纳入基线。
- **后续演进**：key 轮换、吊销和审计流程在进入长期运行阶段后单独定义。
- **权限隔离（RBAC）**：服务端按 key 绑定的 `role_scopes` 做鉴权与资源校验。默认仅 `caller`；`responder` scope 由 remote hotline onboarding/导入后激活。Responder 接口还需校验资源归属（`owner_user_id -> responder_id -> hotline_id` 绑定关系）。

迁移说明：
- 详细的轮换、吊销与长期生命周期设计已迁移到 `../../planned/roadmap/evolution-roadmap.md`。

## 5.6 Responder 公钥轮换协议
- 不属于 L0 基线。
- L0 只要求目录或 `delivery-meta` 能提供单一可信 responder 公钥。
- 多 key 轮换窗口是后续运维能力，进入真实长期运行阶段后单独补充。

迁移说明：
- 详细轮换流程已迁移到 `../../planned/roadmap/evolution-roadmap.md`。

## 6. 状态机与重试幂等

## 6.1 请求状态机（Caller 视角）
- `CREATED`：合约已生成
- `SENT`：任务请求已发出
- `ACKED`：Responder 已接收并通过基础校验
- `SUCCEEDED`：通过最小验收
- `FAILED`：Responder 失败或业务失败
- `TIMED_OUT`：超过硬超时
- `UNVERIFIED`：签名或 schema 验证失败

说明：
- L0 对 Caller 暴露的控制面可观测主状态至少包括 `ACKED` 与 Responder 写入的 `COMPLETED/FAILED` 完成态；`RUNNING/PROGRESS` 仍不在 v0.1 事件范围内。
- `DISPUTED` 属于后续人工复核流程，不纳入 L0 最小闭环。

## 6.2 请求状态机（Responder 视角）

设计态（完整生命周期）：
- `RECEIVED`：收件成功，已提取合同
- `AUTH_CHECKING`：校验 API key/introspect/claims
- `CONTRACT_CHECKING`：字段、版本、超时、任务类型校验
- `QUEUED`：通过校验并入队等待 worker
- `RUNNING`：worker 已取任务执行
- `RESULT_PACKED`：成功结果封包完成
- `ERROR_PACKED`：错误结果封包完成
- `REPLIED`：结果包已按当前 transport 语义回传
- `DONE`：流程结束（含回放命中）

L0 实现简化为 3 态：`QUEUED` → `RUNNING` → `COMPLETED`。RECEIVED/AUTH_CHECKING/CONTRACT_CHECKING 在入队前同步完成，RESULT_PACKED/REPLIED/DONE 合并为 COMPLETED。

## 6.3 请求状态机（Platform 视角）
- `REQUEST_REGISTERED`：Caller request 建立
- `TASK_TOKEN_ISSUED`：task token 已签发
- `DELIVERY_META_ISSUED`：投递元数据已下发
- `ACKED`：Responder ACK 已记录
- `COMPLETED`：Responder 成功结果已封包并完成控制面上报
- `FAILED`：Responder 错误结果已封包并完成控制面上报
- `TIMEOUT_RECORDED`：Caller 超时已记录（后续增强）
- `CLOSED`：请求闭环结束（后续增强）

## 6.4 幂等与去重语义
- Responder 侧以 `request_id` 作为唯一执行键。
- 同 `request_id` 重复到达时：
  - 若已完成，直接回放同一结果包（不重复执行）。
  - 若执行中，返回 `EXEC_IN_PROGRESS`。
- 幂等窗口建议不少于 24 小时。

## 6.5 Responder 队列机制（MVP 建议）
- 入队时机：通过合约与 token 校验后进入 `QUEUED`，再发送 ACK。
- 调度策略：默认 `priority + enqueue_at(FIFO)`。
- worker 机制：`lease_ttl + heartbeat`；worker 异常时任务回退到 `QUEUED`。
- 拒绝语义：队列压力超过阈值返回 `EXEC_QUEUE_FULL` 与 `retry_after_s`。
- 观测项：`queue_depth`、`queue_wait_ms_p95`、`run_ms_p95`、`queue_reject_rate`。

补充说明：
- `tenant_quota` 属于后续多租户扩展，不属于 L0 必备机制。

## 6.6 重试策略
- Caller 只在 `retryable=true` 或传输失败时重试。
- 退避策略：指数退避 + 抖动，最多 3 次。
- 超过 `hard_timeout_s` 不再重试，直接标记 `TIMED_OUT`。

## 6.7 Caller 超时确认与轮询接口（MVP）

- `soft_timeout_s` 到达时：Caller Controller 默认向 Caller Agent 发出“是否继续等待”询问（`timeout_confirmation_mode=ask_by_default`）。
- `hard_timeout_s` 到达时：若未收到明确继续等待指令，Caller Controller 自动将请求终态设为 `TIMED_OUT`。
- `TIMED_OUT` 语义：结束 Caller 本地等待与轮询，不保证也不要求远端 Responder 进程被 kill。

Caller Controller -> Caller Agent 最小查询接口（内部接口）建议：
- `GET /controller/requests/{request_id}`
- 返回最小字段：`request_id`、`status`、`soft_timeout_at`、`hard_timeout_at`、`last_error_code`、`updated_at`、`needs_timeout_confirmation`。
- 终态结果建议挂在 `result_package` 或实现自定义终态字段中。

Caller Agent -> Caller Controller 超时决策接口（内部接口）建议：
- `POST /controller/requests/{request_id}/timeout-decision`
- 请求字段最小集：`continue_wait`（布尔）、`decided_at`（ISO8601 UTC）、`note`（可选）。
- 响应语义：返回当前 `status` 与最新本地状态快照。

## 6.8 最小人工复核通道（MVP）
- 不属于 L0 最小闭环。
- **触发条件**：Caller 对状态为 `SUCCEEDED` 的结果提出内容复核请求（签名和 schema 均通过，但输出不符合预期）。
- **最小流程**：
  1. Caller 向维护方提交复核请求，附 `request_id` 和问题描述。
  2. 维护方人工审核，将该请求状态标记为 `DISPUTED`。
  3. 人工跟进处理并记录结论。
  4. 处理完毕后状态迁移至 `SUCCEEDED`（维持）或 `FAILED`（改判）。
- **MVP 约束**：不引入自动化裁决流程。
- **证据留存**：复核记录、原始合约、结果包、问题描述，最小保留 180 天。

迁移说明：
- 该流程及其扩展治理能力后续统一收敛到 `../../planned/roadmap/evolution-roadmap.md`。

## 7. 超时模型（分层）
- `T_delivery`：transport 投递/收取耗时。
- `T_queue`：Responder 排队等待耗时。
- `T_exec`：Responder 执行耗时。
- `T_accept`：Caller 验收耗时。

总耗时：`T_total = T_delivery + T_queue + T_exec + T_accept`  
指标展示需拆层，否则无法定位瓶颈。

## 8. 错误码体系（v0.1）

实现规则：
- 标准错误码与默认 `retryable` 语义以 `@delexec/contracts` 中的中心注册表为准。
- 说明层文档只描述域与代表性错误，不再手工维护完整散列清单。

建议错误码前缀分域：
- `AUTH_*`：鉴权、token、资源归属
- `CONTRACT_*`：请求体、合约字段、超时/任务类型护栏
- `EXEC_*`：执行、排队、运行期异常
- `RESULT_*`：签名、schema、artifact、结果体解析
- `DELIVERY_*`：投递、接收、速率限制
- `TEMPLATE_*`：模板解析与绑定
- `PLATFORM_*`：平台自身配置与内部故障

实现中还包含资源/运行时相关域，例如 `CATALOG_*`、`REQUEST_*`、`RESPONDER_*`、`USER_*`、`HOTLINE_*`、`TRANSPORT_*`、`SIGNER_*`、`TASK_*`、`CALLER_*`、`RELAY_*`、`OPS_*`。

代表性示例：
- `AUTH_UNAUTHORIZED`
- `AUTH_TOKEN_EXPIRED`
- `CONTRACT_TASK_TYPE_UNSUPPORTED`
- `EXEC_INTERNAL_ERROR`
- `RESULT_SIGNATURE_INVALID`
- `DELIVERY_OR_ACCEPTANCE_TIMEOUT`
- `CATALOG_HOTLINE_NOT_FOUND`
- `REQUEST_ALREADY_TERMINAL`

## 9. 指标与评测最小闭环

## 9.1 Responder 上报指标（最小）
- `request_count`
- `success_count`
- `timeout_count`
- `schema_fail_count`
- `p95_exec_ms`

## 9.2 Caller 观测指标（对照源）
- `caller_seen_success_rate`
- `caller_seen_timeout_rate`
- `caller_seen_unverified_rate`
- `caller_p95_end_to_end_ms`

## 9.3 指标展示建议（MVP）
- 仅展示协议运行所需的聚合硬指标，不做综合评分。
- `sample_size` 应与指标同时展示，避免脱离样本量解读。
- 同类能力可提供横向指标对照表，但不引入推荐结论。

## 9.4 Responder 可用性信号（心跳）

- Responder 周期心跳上报（建议 30 秒一次）。
- 平台维护 `availability_status`：`healthy|degraded|offline`。
- Caller 选路优先 `healthy`，`offline` 默认不选。

## 9.5 告警与仪表盘
- 不属于 L0 最小闭环。
- L0 只要求保留必要事件与健康信号，告警规则和仪表盘放到后续运行阶段定义。

迁移说明：
- 后续运行阶段能力统一记录在 `../../planned/roadmap/evolution-roadmap.md`。

## 10. L0 传输绑定

- L0 当前参考实现绑定 `Local Transport Adapter`。
- 适配器接口以 §2.2B 的 `send / poll / ack / peek / health` 为准，不再另起一套抽象。
- 后续若扩展到 Email、Webhook 或其他 relay，只能在同一适配器边界内替换实现。

## 11. 目录检索可扩展性（MVP 到增强）

MVP 阶段目录项较少，可用“遍历 + 分类过滤”。
MVP 明确不实现搜索引擎能力（联想、模糊、语义召回、复杂推荐）。

### 11.1 MVP 检索模式
- 模式 A：全量遍历（`status=enabled`，可按 `availability_status=healthy` 过滤）
- 模式 B：词条分类（`capability/category/task_type`）

### 11.2 演进目标（后续）
- 联想检索：支持 query suggestion（前缀、同义词、热门词）
- 模糊搜索：拼写容错、近义表达、宽松匹配
- 细分领域策略：按领域启用不同过滤特征与阈值

### 11.3 架构约束（避免重构）
- 查询接口版本化：保留 `/v2/hotlines`，新增 `/v1/catalog/search` 时不破坏旧接口。
- 候选筛选策略外置：以独立配置标识策略，不硬编码在 caller。
- 检索与执行解耦：caller 只消费候选结果，不耦合检索引擎实现。
- 可解释输出：返回 `match_reasons` 与 `score_breakdown`（后续字段）。

迁移说明：
- 搜索、snapshot、changes 与筛选策略的详细演进规划已迁移到 `../../planned/roadmap/evolution-roadmap.md`。

## 12. 风险与缓解

### 12.1 传输通道风险
- 消息乱序/重复：以 `request_id` 去重，结果包带最终态语义。
- 传输延迟不可控：超时分层统计 + 明确时延目标仅对 `T_exec` 生效，`T_delivery` 单独统计。
- 外部 transport 的编码、限流和线程规则由对应 adapter 文档定义，不上升为 L0 协议义务。

### 12.2 安全风险
- token 泄露重放：短时效 + `jti` 记录 + request 绑定。
- 伪造回传结果：强制签名验签，不通过即 `UNVERIFIED`。

### 12.3 外部依赖风险
- **邮箱 MCP**：如果 MCP 协议更新或弃用，需更新 `EmailMcpTransportAdapter`。已通过传输适配器抽象隔离，影响范围限于适配器层。
- **邮箱服务商**：如果服务商变更 API 限制或封禁自动化发送，需切换服务商或降低发送速率。建议使用自有域名邮箱降低风险。
- **PostgreSQL**：主流开源数据库，生态成熟，风险低。
- **Ed25519 签名库**：标准算法，各语言均有成熟实现，风险低。
- **缓解措施**：进入编码阶段后维护 `DEPENDENCIES.md`，记录所有外部依赖的版本、替代方案和风险评级。

## 13. MVP 验收用例（E2E）
- 用例 1 成功：返回合规输出并通过签名验签。
- 用例 2 超时：Responder 超 `hard_timeout_s`，Caller 标记 `TIMED_OUT`。
- 用例 3 token 过期：Responder 拒绝并返回 `AUTH_TOKEN_EXPIRED`。
- 用例 4 输出不合规：Responder 回包 schema 不符，Caller 标记 `UNVERIFIED` 或 `FAILED(RESULT_SCHEMA_INVALID)`。

---

该文档是 v0.1 架构基线，用于指导后续实现任务拆解与接口定义冻结。
