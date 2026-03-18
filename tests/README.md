# Tests

本目录包含 MVP 阶段的测试骨架与联调能力。

## 目录

- `tests/unit`：纯逻辑单测
- `tests/integration`：单服务集成测试（HTTP + 内存状态）
- `tests/e2e`：三端联调场景（成功/超时/token 过期/结果不合规）
- `tests/mocks`：联调 mock（平台、transport 总线、时钟）
- `tests/helpers`：测试工具函数
- `tests/reports`：测试运行产物（`latest.json`）

邮件 transport 相关补充：

- `tests/integration/email-transport.integration.test.js`
  - 内存邮件 transport 抽象测试
- `tests/integration/emailengine-transport.integration.test.js`
  - EmailEngine REST `API v1` adapter 测试
- `tests/integration/gmail-transport.integration.test.js`
  - Gmail `gmail/v1` adapter 测试

## 运行

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:e2e:ui`（Vitest Web UI）
- `npm run test:deploy:config`
- `npm run test:smoke:platform`
- `npm run test:smoke:buyer`
- `npm run test:smoke:seller`
- `npm run test:compose-smoke`
- `npm run test:public-stack-smoke`
- `npm run test:local-images-smoke`
- `npm run test:published-images-smoke`

`compose-smoke` 补充说明：
- 默认会为每次运行生成独立的 `COMPOSE_PROJECT_NAME`，避免与本机其他 compose 栈互相污染。
- 运行前会先做 `docker compose config` 预校验，并对同项目做一次 `down --remove-orphans -v` 预清理。
- 对 `image_pull_failed` 会做有限次自动重试（默认 2 次，可用 `COMPOSE_IMAGE_PULL_RETRIES` 覆盖）。
- 失败分类重点区分：`image_pull_failed`、`port_conflict`、`service_runtime_failed`、`health_check_timeout`、业务链路回归。

镜像型 smoke 区分：

- `test:local-images-smoke`
  - 依赖本机构建好的 release-shaped 镜像
  - 主要用于 CI 中验证 image-based compose path 本身
- `test:published-images-smoke`
  - 直接尝试从 `IMAGE_REGISTRY/IMAGE_TAG` 拉取镜像
  - 当前默认目标是 `ghcr.io/hejiajiudeeyu`
  - 更适合 release 后或手动 workflow 验证

## 流程图反馈

`npm run test:e2e` 会写出 `tests/reports/latest.json`，可在
`site/protocol-playground.html` 中加载并把问题映射到时序图步骤编号（如 `F1-F1`）。
