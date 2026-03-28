远程热线协议架构设计（MVP）

> 英文版：[architecture.md](architecture.md)
> 说明：中文文档为准。

# 远程热线协议架构设计（MVP）

## 1.范围与原则

### 1.1 MVP 目标
- 先用 `L0 local Transport` 验证 `Remote Hotline Protocol` 闭环是否成立；外部通信保持为 `Transport Adapter` 抽象，`Email MCP` 只是备选实现之一。
- 平台只做最小化控制面：目录、代币、投递元数据、事件、指标聚合。
- Caller仅处理输入输出，不承载Responder依赖。
- 任何特定产品层、分发层和垂直实现层都被视为协议上的上层实现，不导入当前协议核心定义。

### 1.2 非目标
- 不做实时低延迟通道保证（MVP默认按异步通信模型设计）。
- 不做与协议闭环无关的外围业务系统。
- 不做尊贵评价驱动的展示、打分或推荐体系。

### 1.3 关键设计原则
- 约定优先：所有交互可实现为构造 JSON。
- 幂等优先：`request_id`贯穿全仓库。
- 可迁移优先：通过学生抽象传输通道，与业务状态机解耦。
- 最大信任：短期代币+结果签名，平台不托管长期托管。
- 本地控制面最小暴露：控制台接口不直接持有长期API key，优先通过本地会话+加密秘密存储+网关/supervisor代理访问敏感能力。
- 模式解耦：`L0-L3`的差异仅体现在控制器间的通信拓扑与运行边界，无法改变核心协议语义、请求/结果结构、状态机迁移规则与幂等规则。

补充语义：
- 本协议中的“远程”是指执行边界与信任边界，而不是物理部署距离。
- 因此，单机`L0本地传输`、交换机`L2`、以及外部通道`L3`都可以是`Remote Hotline Protocol`的有效运行模式。

### 1.4 文档真相源与合理分层

为了避免多个文档中重复发明相同的事实，本仓库采用“真相层 -> 规范层 -> 说明层”的文档分层。

- 真相源（运行时真相源）
  - `apps/*/src/server.js`：运行时API行为、鉴权分支、状态迁移、实际返回结构
  - `tests/integration/*`、`tests/e2e/*`：运行时行为验证
  - `docs/templates/hotlines/*/*.json`：模板输入输出结构与示例
  - `tests/unit/schema-validation.test.js`：模板 schema 机械校验
- 原则级真相源（架构真相源）
  - `architecture.md`：系统边界、职责、模式不变量、语义分层、版本与信任模型
- 规范层衍生品（normativeinders）
  - `platform-api-v0.1.md`：对外API规范说明，必须贴合运行时真相源
  - `integration-playbook.md`：端到端接入与联调手册，必须贴合运行时真相源与架构不变量
  - `defaults-v0.1.md`：冻结默认参数必须，贴合实现与架构约束
- 说明层硬度（描述性导数）
  - `README.md` / `README.zh-CN.md`
  - `文档/当前/图表/*`
  - `文档/当前/测试/*`
  - `../status/current-implementation-status.md`

维护规则：

- 说明层文档不得自行发明接口字段、状态枚举、错误码和返回结构。
- 若规范层与运行时真相源发生冲突，先修改代码或测试，再回补规范层文档。
- 若图标与规范层冲突，以规范层相同，并在同一变更中修改图。
- 参考图：`../diagrams/doc-truth-source-map.md`

## 2. 系统边界与组件

## 2.1 角色
- Caller（Caller）
- Responder（Responder）
- 平台（Platform）
- 任选上层：目录维护方、集成协调方

## 2.1A 术语映射（协议层 vs 参考实现层）

- `Caller Agent`：发起本地智能体；在用户叙述中可等价理解为`Local Agent`。
- `Remote Hotline`：Responder发布并远程执行的能力单元，由 `responder_id + hotline_id` 标识。
- `Responder`：远程热线的发布者/维护者/资源归属主体。
- `Caller Controller`、`Responder Controller`：本仓库中的参考实现组件，不增加新的协议角色。

补充规定：
- 面向协议读者时，优先使用 `Caller Agent (Local Agent)` 与 `Remote Hotline`。
- 针对本仓库实现时，再使用 `Caller Controller`、`Responder Controller` 等名称组件。
- 更完整的迁移建议请参见“../../planned/roadmap/evolution-roadmap.md”。

## 2.2 MVP 组件
- Caller本地代理运行时（当前参考实现：`Caller Controller`）
  - 任务拆解、合约构建、代币申请、请求投递、轮询、最小验收、状态管理。
- Remote Hotline Runtime Template（当前参考实现：`Responder Controller` + 执行器模板）
  - 收件、约定校验、令牌校验、执行器调用、结果回传、权力等去重、指标上报。
- 平台最低限度服务
  - 目录注册/查询、模板包下发、令牌发送/校验、投递元数据下发、请求事件接收、Responder心跳与可用性判定、指标接收/聚合。
- 传输适配器实现
  - `Local Transport Adapter`（当前已实现）：单机内存队列；提供 `send / poll / ack / peek / health` 最小接口，作为 `L0` 运行模式的控制器间通信通道。
  - 候选外部实现：`Email MCP Adapter`、`SMTP/API Email Bridge Adapter`、`HTTP/Webhook Adapter`。

## 2.2A 分层运行模式（后续演进约束）

为避免将不同通信方式多套协议实现，系统后续演进采用“同一内核、多种运行模式”策略。`L0-L3`是部署/通信模式，不是四套业务协议。

- `L0：本地运行时`
  - 单机并发运行；可包含多worker、多hotline隔离。
  - 控制器间通信可通过进程内队列、本机IPC或等价本地完成通道。
  - 当前仓库已实现最小内存队列版本`本地传输`，用于Caller/Responder/平台联调与E2E。
- `L1：本地虚拟邮箱`
  - 单机运行，但输入本地虚拟中转站/邮箱命名空间，验证异步投递、线程异步与ACL。
- `L2：局域网中继`
  - 控制器跨边界设备通信，引入节点注册、心跳、路由与断线恢复。
- `L3：外部传输桥`
  - 通过外部异步通道完成控制器间通信；可实例化为`Email MCP`、`SMTP/API电子邮件桥接`、`HTTP/Webhook中继`等模式。

所有型号共享以下不参数：

- 统一 `request_id` / `thread_hint` / `message Envelope` 语义。
- 统一ACK、超时、重试、幂等规则。
- 统一Caller/Responder/平台角色职责。
- 统一结果签名、错误码域和终态判定。

允许变化的只有：

- 控制器间消息如何发送、投递、轮询、路由。
- 中继/邮箱/网络边界的位置。
- 通信侧鉴权与节点发现的具体实现。

## 2.2B TransportAdapter接口最小（模式切换边界）

为保证`L0-L3`只是运行模式切换而不是协议重写，控制器与通信层之间必须只通过统一的`TransportAdapter`交互。业务层无法直接感知“本地队列 / 虚拟邮箱 / LAN 中继 / MCP / Email / HTTP Webhook”的实现差异。

建议最小接口：

- `发送（信封）`：
  - 输入统一消息封装，至少包含 `message_id`, `request_id`, `thread_hint`, `from`, `to`, `message_type`, `payload`, `created_at`
  - 返回发送后的完整消息对象（含生成的 `message_id` 和 `queued_at`）
- `轮询({ limit, 接收者 })`：
  - 拉取当前控制器可见的新消息
  - 返回 `{ items }` 内存
- `ack(message_id)`：
  - 确认某条传输消息已被本地消费，避免重复投递
  - 返回 `{ acked: true|false }`
- `peek({ thread_id })`（任选）：
  - 按线程或请求维度查询调试视图，如图playground / debugger / 运维排障
- `健康()`：
  - 返回 Transport 当前健康状态、队列深度、receiver 标识

统一消息封装建议字段：

- `message_id`：传输消息唯一标识
- `request_id`：业务权力等主键
- `thread_hint`：线程辅助标识
- `from` / `to`：控制器或邮箱身份
- `message_type`：如`task_contract`, `result_package`, `transport_ack`
- `payload`：任务或结果正文
- `meta`：传输侧元数据（priority、ttl、attempt、trace_id）
- `创建于`

实现约束：

- `send/poll/ack` 语义在 `L0-L3` 中必须保持一致。
- 传输层允许“至少一次投递”，但控制器必须基于 `request_id + message_type` 做幂等。
- Transport 层无法重写业务 Payload 结构，只能附加 `meta`。
- `health()` / `peek()` 可因模式能力不同而返回不同的细节，但返回结构应保持兼容。

## 2.3 信任边界
- 平台信任自身发行代币，不信任内容正确性。
- Caller信任平台签发能力，不默认信任Responder回传内容。
- Responder信任代币的授权边界，不信任外部输入参数合法性。

目前实现约束：
- Caller验签必须使用平台目录/`delivery-meta`绑定的`responder_public_key_pem`，不得信任结果包自带灯泡。
- Responder侧敏感平台接口（如`introspect`、`ack`、`heartbeat`）必须同时满足`responder range + responder_id/hotline_id`资源归属。

## 3. 全局标识与版本策略

## 3.1 必备标志
- `request_id`：一次任务请求全局唯一（UUIDv7 推荐）。
- `user_id`：用户主体标识（注册后默认具备Caller角色）。
- `caller_id`：Caller角色标识（可与`user_id`同值映射）。
- `responder_id`：Responder角色标识（由remote hotline onboarding/导入后激活）。
- `hotline_id`：Responder发布的远程热线标识。
- `contract_version`：任务合约版本（如`0.1.0`）。
- `result_version`：结果包版本（如`0.1.0`）。

v0.1 地图约束（冻结）：
- `caller_id = user_id`（偶一）
- `responder_id` 在该用户首次远程热线加入完成并导入成功时生成
- v0.1默认一个`user_id`仅绑定一个`responder_id`（后续版本再支持多个Responder身份）

## 3.2 兼容策略
- 仅允许稀疏兼容新增字段（任选字段）。
- 主版本升级表示不兼容变更。
- v0.1不引入多版本协商字段；若后续需要并存版本，再引入显式版本窗口声明。

## 3.3 模式演进与版本升级
- **数据库迁移工具**：建议使用语言生态主流工具（Node.js 使用 `prisma migrate`，Python 使用 `alembic`），schema 变更必须提交 PR 并且附迁移脚本。
- **非破坏性变更（v0.1.x）**：增加五个字段，不修改现有字段相关，接收方忽略未知字段。
- **L0约束**：当前只调用单一版本`0.1.0`，不在L0核心中引入多版本路由、弃用通知或版本共存流程。
- **后续演进**：若进入多版本并存阶段，再单独定义废弃通知、迁移策略和路由策略。

## 4.合同与结果包规范（v0.1）

## 4.1 任务合同字段（最小集）
- `request_id`：幂等主键。
- `合约版本`
- `创建于`（ISO8601）
- `caller`：`caller_id`、`result_delivery`（任选；当前实现支持`email|local|relay_http`，工件`platform_inbox`）
- `responder`：`responder_id`、目标`hotline_id`
- `task`：`task_type`、`input`、`output_schema`
- `约束`：`soft_timeout_s`、`hard_timeout_s`
- `token`：短期任务代币（JWT 或等价结构）
- `trace`：`thread_hint`、`source_run_id`

译文：
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
- `结果版本`
- `responder_id`、`hotline_id`
- `status`（当前线级实现）：`ok |错误`
- `output`：成功结果（需满足`output_schema`）
- `error`：失败时提供`code`、`message`、`retryable`
- `timing`：`accepted_at`、`finished_at`、`elapsed_ms`
- `usage`（可选）：实现自定义资源统计
- `signature_algorithm`、`signature_base64`：Responder签名字段（伪防与去重）

说明：
- Responder当前发送的是线级结果包：`status=ok|error`
- Caller Controller 在验签与 schema 状态验证后，再将本地请求归一化为 `SUCCEEDED |失败 |未经证实 |超时`
- 因此 `ok|error` 是传输层结果语义，`SUCCEEDED|FAILED|...` 是 Caller 本地状态机语义
- 结果包可携带 `signer_public_key_pem` 作为调试信息，但Caller的信任根必须来自目录或 `delivery-meta` 预绑定。

译文：
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
- 协议主键永远使用`request_id`；`thread_hint`仅作同请求的关联辅助。
- L0基线未规定邮件主题、线程头或特定通道格式。
- 若某传输需要额外队列，应由对应适配器文档补充，不反向定义协议核心字段。

## 4.4 错误结果包与投递元数据规则

### 错误结果包校验（与成功结果同级）
- 当前线级结果包中，`status=error` 时必须返回 `error.code/message/retryable`。
- Caller对错误结果包执行与成功包一致的机械校验：`request_id`、`responder_id/hotline_id`、signature、version。
- 校验通过的错误结果包可进入Caller后续决策循环（重试、切换候选或人工复核），而不是直接丢弃。

### 投递地址暴露策略（v0.1）
- `task_delivery` / `result_delivery` 不在目录批量查询中下发，避免被目录抓取中断。
- `task_delivery.address` 是不透明的传输端点；实现可将其编码为本地邮箱、中继URI、电子邮件地址或其他传输特定的字符串。
- Caller在获取 token 后，通过 `POST /v1/requests/{request_id}/delivery-meta` 单次获取节点路由与 `verification`。
- `delivery-meta` 与 `request_id + responder_id + hotline_id + Caller_id` 绑定，期间不可复用。

## 4.5 能力声明模板（Capability Templates）

### 目的
解决买卖双方信息不及时的问题：Caller在选择热线后，需要明确**应提供哪些输入**以及**将获得什么格式的输出**。模板机制通过格式化的模式和示例实现渐进式披露。

### 模板目录结构
每个注册热线在仓库中已维护一组模板文件：

```
docs/templates/hotlines/{hotline_id}/
├── input.schema.json      # 输入 JSON Schema，定义 task.input 字段
├── output.schema.json     # 输出 JSON Schema，定义 task.output_schema
├── example-contract.json  # 完整合约示例
├── example-result.json    # 完整结果包示例
└── README.md              # 能力说明、标签集、约束、快速开始
```

### 目录关联
目录入口增加 `template_ref` 字段，作为该热线模板海关绑定键：
```json
{
  "hotline_id": "foxlab.text.classifier.v1",
  "template_ref": "docs/templates/hotlines/foxlab.text.classifier.v1/",
  ...
}
```

### 渐进式披露流程
1. **浏览目录**：Caller查询`/v2/hotlines`，获取概要信息（description、capability、eta_hint 等）。
2. **选择热线**：Caller确定目标热线后，通过 `GET /v2/hotlines/{hotline_id}/template-bundle?template_ref=...` 获取模板包。
3. **构造契约**：Caller参照 `input.schema.json` 填写 `task.input`，用 `output.schema.json` 设置 `task.output_schema`。
4. **参考示例**：`example-contract.json` 和 `example-result.json` 提供最终的请求响应样本。

### 模板维护规范
- 模板文件由Responder维护，通过PR提交更新。
- Schema变更遵循一致性策略版本（§3.2）：仅允许逻辑兼容新增字段。
- 平台在合并模板 PR 后自动更新目录的 `updated_at` 计时器。
- MVP阶段模板仍存储在Git仓库中，但对Caller通过平台API下发统一，不暴露仓库直读依赖。

## 5. Token与签名模型

## 5.1 任务令牌必备声明
- `iss`：平台发行者
- `aud`：目标`responder_id`
- `sub`：`caller_id`
- `request_id`
- `hotline_id`
- `iat`、`exp`
- `jti`（唯一代币id）

## 5.2 校验规则
- Responder必须校验 `aud/sub/request_id/hotline_id/exp`。
- v0.1 Responder统一通过 `introspect` 在线校验代币。
- token默认短效（当前冻结为5分钟，需覆盖单次传输投递与ACK观察窗口），超时拒绝执行。
- **introspect 性能目标**：P99 < 200ms。服务端建议对 introspect 添加简单缓存（token hash -> 校验结果，TTL 30s），降低重复校验增量。
- **本地校验初始化（v0.2）**：后续可支持Responder缓存平台进行本地JWT验签，仅对高风险或异常请求回退到在线自省。

## 5.3 结果签名
- Responder使用私钥对结果包规范的JSON签名。
- Caller通过目录中的Responder客户端验证签名。
- 签名失败结果标记为“UNVERIFIED”，不进入成功统计。

## 5.4 Token传输安全
- 外部梯度通道不保证端到端加密时，token在传输中存在被截获的理论风险。
- MVP 接受此风险，依靠三重防护组合降低实际影响：
  1. **单次使用**：`jti`全局唯一，Responder通过内省去重，同一个token无法重放。
  2. **短时效**：token TTL当前默认5分钟，攻击窗口极小。
  3. **请求绑定**：token Claims中绑定 `request_id/caller_id/responder_id/hotline_id`，无法挪用其他请求。
- L0`本地传输`不引入额外网络传输风险；上述风险主要针对后续外部传输。

## 5.5 API 密钥生命周期
- **签发**：用户主体注册成功后，平台签发API Key（默认 `role_scopes={caller}`）。
- **L0约束**：v0.1只要求密钥能签发并用于RBAC鉴权，不把轮换、自助吊销基线。
- **后续演进**：键轮换、吊销和审计流程在进入长期运行阶段后单独定义。
- **权限隔离（RBAC）**：服务端按 key 绑定的 `role_scopes` 做鉴权与资源验证。默认仅 `caller` 关系；`responder` 范围由远程热线入职/导入后激活。Responder接口还需验证资源归属（`owner_user_id -> responder_id -> hotline_id` 绑定）。

迁移说明：
- 详细的轮换、吊销与长期生命周期设计已迁移到`../../planned/roadmap/evolution-roadmap.md`。

## 5.6 Responder轮换协议
- 不属于L0基线。
- L0 只要求目录或 `delivery-meta` 能够提供唯一可信的ResponderResponder。
- 多键轮换窗口是后续运维能力，进入真正的长期运行阶段后单独补充。

迁移说明：
- 详细轮换流程已迁移到 `../../planned/roadmap/evolution-roadmap.md`。

## 6.状态机与重试权力等

## 6.1 请求状态机（Caller视角）
- `CREATED`：合约已生成
- `SENT`：任务请求已发布
- `ACKED`：Responder已接收并通过基础校验
- `SUCCEEDED`：通过最小赞赏
- `FAILED`：Responder失败或业务失败
- `TIMED_OUT`：超过硬超时
- `UNVERIFIED`：签名或模式验证失败

说明：
- L0 对Caller暴露的控制面可启动主状态至少包括 `ACKED` 和Responder写入的 `COMPLETED/FAILED` 完成状态；`RUNNING/PROGRESS` 仍不在 v0.1 事件范围内。
- `DISPUTED`属于后续人工复核流程，不纳入L0最小闭环。

## 6.2 请求状态机（Responder视角）

设计态（完整生命周期）：
- `RECEIVED`：收件成功，已提取合同
- `AUTH_CHECKING`：验证API key/introspect/claims
- `CONTRACT_CHECKING`：字段、版本、超时、任务校验类型
- `QUEUED`：通过校验并入队等待worker
- `RUNNING`：worker 已取任务执行
- `RESULT_PACKED`：成功结果封包完成
- `ERROR_PACKED`：错误结果封包完成
- `REPLIED`：结果包已按当前运输 语义回传
- `DONE`：流程结束（含回放时间表）

L0 实现简化为 3 态：`QUEUED` → `RUNNING` → `COMPLETED`。RECEIVED/AUTH_CHECKING/CONTRACT_CHECKING 在入队前同步完成，RESULT_PACKED/REPLIED/DONE 合并为 COMPLETED。

## 6.3 请求状态机（平台视角）
- `REQUEST_REGISTERED`：Caller请求已建立
- `TASK_TOKEN_ISSUED`：任务令牌已签发
- `DELIVERY_META_ISSUED`：投递元数据已下发
- `ACKED`：Responder确认已记录
- `COMPLETED`：Responder成功结果已封包并完成控制面报
- `FAILED`：Responder错误结果已封包并完成控制面报
- `TIMEOUT_RECORDED`：Caller超时已记录（后续增强）
- `CLOSED`：请求闭环结束（后续增强）

## 6.4 幂等与去重语义
- Responder侧以 `request_id` 作为唯一执行键。
- 同 `request_id` 重复到达时：
  - 若已完成，直接回传相同结果包（不重复执行）。
  - 若执行中，返回 `EXEC_IN_PROGRESS`。
- 幂等窗口显示于24小时。

## 6.5 Responder队列（MVP建议）
- 入队时机：通过合约与 token 验证后进入 `QUEUED`，再发送 ACK。
- 调度：默认策略 `priority + enqueue_at(FIFO)`。
-worker机制：`lease_ttl + heartbeat`；worker异常时任务回退到`QUEUED`。
- 拒绝队列：队列压力超过阈值返回 `EXEC_QUEUE_FULL` 与 `retry_after_s`。
- 起始项：`queue_depth`、`queue_wait_ms_p95`、`run_ms_p95`、`queue_reject_rate`。

补充说明：
- `tenant_quota` 属于后续多机场扩展，不属于 L0 必备机制。

## 6.6 重试策略
- Caller只需在 `retryable=true` 或传输失败时重试。
- 退避策略：指数退避 + 脚趾，最多 3 次。
- 超过`hard_timeout_s`不再重试，直接标记`TIMED_OUT`。

## 6.7 Caller超时确认与轮询接口（MVP）

- `soft_timeout_s`到达时：Caller控制器默认向Caller代理发出“是否继续等待”询问（`timeout_confirmation_mode=ask_by_default`）。
- `hard_timeout_s` 到达时：若未收到明确的继续等待指令，Caller控制器自动将请求终态设为 `TIMED_OUT`。
- `TIMED_OUT` 语义：结束Caller本地等待与轮询，不保证也不要求远端Responder进程被杀死。

Caller Controller -> Caller Agent 最小查询接口（内部接口）建议：
- `GET /controller/requests/{request_id}`
- 返回最小字段：`request_id`、`status`、`soft_timeout_at`、`hard_timeout_at`、`last_error_code`、`updated_at`、`needs_timeout_confirmation`。
-终态结果建议挂在 `result_package` 或实现自定义终态字段中。

Caller Agent -> Caller Controller 超时决策接口（内部接口）建议：
- `POST /controller/requests/{request_id}/timeout-decision`
- 请求字段最小集：`continue_wait`（布尔）、`decided_at`（ISO8601 UTC）、`note`（可选）。
- 响应回复：返回当前 `status` 与最新本地状态快照。

## 6.8最小人工复核通道（MVP）
- 不属于L0最小闭环。
- **触发条件**：Caller对状态为`SUCCEEDED`的结果提出内容复核请求（签名和模式均通过，但输出不符合预期）。
- **最小流程**：
  1. Caller向维护方提交复核请求，附上 `request_id` 和问题描述。
  2. 维护方人工审核，将请求状态标记为“DISPUTED”。
  3. 人工跟进处理并记录结论。
  4. 处理完毕后状态迁移至`SUCCEEDED`（维持）或`FAILED`（改判）。
- **MVP约束**：不引入自动化裁决流程。
- **证据留存**：复核记录、原始合同、结果包、问题描述，最小保留180天。

迁移说明：
- 该流程及其扩展治理能力后续统一收敛到`../../planned/roadmap/evolution-roadmap.md`。

## 7.超时模型（分层）
- `T_delivery`：运输投递/提前运行。
- `T_queue`：顾客排队等待时间。
- `T_exec`：Responder执行运行时间。
- `T_accept`：Caller验收结束。

总运行：`T_total = T_delivery + T_queue + T_exec + T_accept`  
指标显示需拆层，否则无法定位瓶颈。

## 8. 错误码体系（v0.1）

实现规则：
- 标准错误码与默认 `retryable` 语义以 `@delexec/contracts` 中的中心樱桃。
- 说明层文档只描述域与关键错误，不再手工维护完整的散列清单。

建议错误码周边分域：
- `AUTH_*`：鉴权、token、资源归属
- `CONTRACT_*`：请求体、约定字段、超时/任务类型护栏
- `EXEC_*`：执行、排队、运行期异常
- `RESULT_*`：签名、schema、artifact、结果体解析
- `DELIVERY_*`：投递、接收、速率限制
- `TEMPLATE_*`：模板解析与绑定
- `PLATFORM_*`：平台自身配置与内部故障

实现中还包含资源/运行时相关领域，例如 `CATALOG_*`、`REQUEST_*`、`RESPONDER_*`、`USER_*`、`HOTLINE_*`、`TRANSPORT_*`、`SIGNER_*`、`TASK_*`、`CALLER_*`、`RELAY_*`、`OPS_*`。

主题示例：
- `AUTH_UNAUTHORIZED`
- `AUTH_TOKEN_EXPIRED`
- `合同任务类型_不支持`
- `执行内部错误`
- `RESULT_SIGNATURE_INVALID`
- `DELIVERY_OR_ACCEPTANCE_TIMEOUT`
- `CATALOG_HOTLINE_NOT_FOUND`
- `REQUEST_ALREADY_TERMINAL`

## 9. 指标与体育最小闭环

## 9.1 Responder上报指标（最小）
- `请求计数`
- `成功计数`
- `超时计数`
- `schema_fail_count`
- `p95_exec_ms`

## 9.2 Caller落地指标（对照源）
- `caller_seen_success_rate`
- `caller_seen_timeout_rate`
- `caller_seen_unverified_rate`
- `caller_p95_end_to_end_ms`

## 9.3 展示指标建议（MVP）
- 仅显示协议运行所需的聚合硬指标，不做综合评分。
- `sample_size`应与指标同时展示，避免分段样本量读取。
- 同类能力可提供横向指标对照表，但不引入推荐结论。

## 9.4 Responder可用性信号（心跳）

- Responder周期心跳上报（建议30秒一次）。
- 平台维护 `availability_status`：`healthy|degraded|offline`。
- Caller选路优先`健康`，`离线`默认不选。

## 9.5 其余与仪表盘
- 不属于L0最小闭环。
- L0 只要求保留必要事件与健康信号，还有规则和仪表盘放置后续运行阶段定义。

迁移说明：
- 后续运行阶段能力统一记录于`../../planned/roadmap/evolution-roadmap.md`。

## 10. L0传输绑定

- L0 当前参考实现绑定 `Local Transport Adapter`。
- 适配器接口以 §2.2B 的 `send / poll / ack / peek / health` 睡姿，不再起一套抽象。
- 后续若队列Email、Webhook或其他中继，只能在同一队列内替换实现。

## 11.目录搜索可扩展性（MVP 到增强）

MVP阶段目录项很少，可以“遍历+分类过滤”。
MVP 明确未实现搜索引擎能力（联想、模糊、举报、复杂推荐）。

### 11.1 MVP 检索模式
- 模式A：全量遍历（`status=enabled`，可按`availability_status=healthy`过滤）
- 模式B：词条分类（`能力/类别/任务类型`）

### 11.2演进目标（后续）
- 关联检索：支持查询建议（外接、同义词、热门词）
- 模糊搜索：拼写错误、近义表达、广泛匹配
- 细分领域策略：按领域启用不同过滤特征与阈值

### 11.3 架构约束（避免架构）
- 查询接口版本化：保留`/v2/hotlines`，新增`/v1/catalog/search`时不破坏旧接口。
- 筛选筛选策略外置：以独立配置标识策略，不编码硬于Caller。
- 搜索与执行解耦合：Caller只消费候选结果，不耦合搜索引擎实现。
- 可解释输出：返回 `match_reasons` 与 `score_breakdown`（后续字段）。

迁移说明：
- 搜索、快照、变更与策略筛选的详细演进规划已迁移至`../../planned/roadmap/evolution-roadmap.md`。

## 12.风险与缓解

###风险12.1传输通道
- 消息乱序/重复：以`request_id`去重，结果包带最终形态语义。
- 传输延迟不可控：超时分层统计 + 明确的时延目标仅对 `T_exec` 生效，`T_delivery` 单独统计。
- 外部传输的编码、限制流和线程规则由对应适配器文档定义，不上升为 L0 协议义务。

### 12.2 安全风险
- token泄露重放：短时效 + `jti`记录 + request 绑定。
- 发票回传结果：强制签名验签，不通过即`UNVERIFIED`。

### 风险 12.3 外部依赖
- **邮箱MCP**：如果MCP协议更新或弃用，需更新 `EmailMcpTransportAdapter`。已通过传输口罩抽象隔离，影响范围仅限于恐龙层。
- **邮箱风险限制服务商**：如果服务商变更API或封禁自动化发送，需切换服务商或降低发送速率。建议使用自有域名邮箱降低。
- **PostgreSQL**：主流数据库，生态技术，风险低。
- **Ed25519 签名库**：标准算法，各语言成熟成熟，风险低。
- **缓解措施**：进入编码阶段后维护`DEPENDENCIES.md`，记录所有外部依赖的版本、替代方案和风险评级。

## 13. MVP 惊喜示例（E2E）
- 示例1成功：返回合产出规范并通过签验签。
- 示例2超时：Responder超过`hard_timeout_s`，Caller标记`TIMED_OUT`。
- 示例 3 token 过渡：Responder拒绝并返回 `AUTH_TOKEN_EXPIRED`。
- 示例4输出不合规：Responder回包schema不符，Caller标记`UNVERIFIED`或`FAILED(RESULT_SCHEMA_INVALID)`。

---

该文档是 v0.1 架构核心，用于指导后续实现任务拆解和接口定义冻结。
