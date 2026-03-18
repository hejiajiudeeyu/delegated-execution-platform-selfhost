# Testing Strategy (MVP v0.1)

预拆分附加规则：

- E2E 与 compatibility 测试优先使用独立进程边界，不直接 import 各服务的 server factory
- 未来跨仓验收的启动约定见 [Cross-Repo Compatibility Testing](/Users/hejiajiudeeyu/Documents/Projects/remote-subagent-protocol/docs/current/testing/cross-repo-compatibility-testing.md)

## 1. 目标

建立可持续测试体系，覆盖三端基础行为、核心失败分支，以及面向调试的双反馈面：

- TUI：终端实时结果（Vitest）
- Web UI：流程图定位失败步骤（Flow Dashboard）

## 2. 分层策略

- Unit：状态机、错误码、schema 约束等纯逻辑
- Integration：单服务 HTTP 接口与内存状态行为
- E2E：Platform + Buyer Controller + Seller Controller 的端到端场景，按独立进程 / HTTP 边界运行
- Compose Smoke：Docker 真实进程冒烟（`tests/smoke/compose-smoke.mjs`）

## 3. 场景来源

测试场景由两部分共同定义：

- 流程图（步骤覆盖与编号锚点）：`../diagrams/user-remote-subagent-call-flow.md`
- 规范文档（断言口径）：`../spec/architecture.md`、`../spec/platform-api-v0.1.md`、`../guides/integration-playbook.md`

## 4. Mock / Runtime 策略

`tests/mocks/` 下存放以下替身定义（当前为预留，集成和 E2E 测试直接使用真实内存态服务实例）：

- `MockPlatformApi`：注册、token、introspect 的轻量替身
- `MockEmailBus`：模拟投递、轮询
- `FakeClock`：超时测试中的可控时间源

当前默认联调以本地参考 transport 为主：
- Buyer 通过 `dispatch` 把任务 envelope 写入本地 transport
- Seller 通过 `inbox/pull` 拉取并 ACK 本地 transport 消息
- Platform 继续只承担控制面职责

Mock 仍用于单点接口与失败分支测试；真实邮件通道测试放在补充冒烟链路。

## 4.1 真实进程联调（Compose Smoke）

- 入口：`npm run test:compose-smoke`
- 严格入口：`npm run test:compose-smoke:strict`
- 行为：启动 `docker-compose.yml`，等待三端健康检查，执行最小成功链路，再自动 `down`
- 目标：验证“真实进程 + 网络 + 端口映射 + 服务组合”无基础阻断
- 严格模式语义：docker 不可用时直接失败，避免 CI 中出现“被动跳过”的假阳性

## 5. 流程图问题定位

E2E 输出 `tests/reports/latest.json`，每条问题记录包含：

- `case_id`
- `flow_step_id`（如 `F1-F1`）
- `error_code`
- `severity`
- `message`

Web UI 加载该报告并在流程图中高亮对应步骤。

## 6. MVP 首批验收

- 成功：终态 `SUCCEEDED`
- 超时：终态 `TIMED_OUT`
- token 过期：`AUTH_TOKEN_EXPIRED`
- 结果不合规：`RESULT_SCHEMA_INVALID` / `UNVERIFIED`

并覆盖“错误结果包可被 buyer 验收并反馈”的路径。

当前 E2E 额外已验证：
- Seller 结果验签使用预绑定信任公钥，而非结果包自带公钥
- `delivery-meta` 与 token claims 的 `request_id/seller_id/subagent_id/buyer_id` 绑定
- 平台 seller 侧接口的最小 RBAC 约束
