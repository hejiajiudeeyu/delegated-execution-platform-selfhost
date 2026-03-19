# 测试说明

> 英文版：./README.md
> 说明：中文文档为准。

本目录包含 self-hosted platform 仓当前默认启用的测试与验证脚本。

## 目录

- `tests/integration`：平台仓默认集成测试（gateway、relay-http 等）
- `tests/e2e`：跨仓兼容与历史联调用例，不属于当前平台仓默认 CI
- `tests/helpers`：测试工具函数
- `tests/reports`：测试运行产物（`latest.json`）

## 运行

- `npm run test:integration`
- `npm run test`
- `npm run test:deploy:config`
- `npm run test:public-stack-smoke`
- `npm run test:service:packages`
- `npm run test:release:docs`

`public-stack-smoke` 补充说明：
- 默认会为每次运行生成独立的 `COMPOSE_PROJECT_NAME`，避免与本机其他 compose 栈互相污染。
- 运行前会先做 `docker compose config` 预校验，并对同项目做一次 `down --remove-orphans -v` 预清理。
- 既可验证 source-build 路径，也可通过 `COMPOSE_NO_BUILD=true` 验证已发布镜像路径。

## 流程图反馈

`npm run test:e2e` 会写出 `tests/reports/latest.json`，可在
`site/protocol-playground.html` 中加载并把问题映射到时序图步骤编号（如 `F1-F1`）。
