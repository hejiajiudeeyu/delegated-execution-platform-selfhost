# 运维部署

> 英文版：./README.md
> 说明：中文文档为准。

此 compose profile 用于本地开发、演示与高级自管场景。
它不再是终端用户 ops 客户端的主要安装路径。

终端用户 caller/responder 安装建议：

1. `npm install`
2. `npm run ops -- bootstrap --email you@example.com --platform http://127.0.0.1:8080`
2. 若你希望自定义 worker（而非内置示例），使用：
   `npm run ops -- add-hotline --type process --hotline-id local.echo.v1 --cmd "node worker.js"`
3. `npm run ops -- doctor` / `npm run ops -- debug-snapshot`

该路径会启动本地 supervisor，统一管理 caller 与可选 responder；在 local transport 模式下，它会以独立进程启动 relay，而不是直接 import relay 源码。
运行日志写入 `~/.delexec/logs`，可在 `ops-console` 或 `debug-snapshot` 查看。
`ops-console` 现提供本地 caller/responder onboarding 的 setup wizard，终端用户无需记忆完整步骤顺序。

Relay 启动说明：
- `ops` 现在优先使用外部 relay 进程边界
- 当希望 supervisor 启动自定义 relay 命令时，设置 `OPS_RELAY_BIN` 与可选 `OPS_RELAY_ARGS`
- 当运行时传输为 `relay_http` 时，supervisor 使用配置的远端 relay，不需要管理本地 relay 进程

Compose profile 行为：
- `caller-controller` 始终开启
- `relay` 始终开启
- `responder-controller` 可选，仅在启用 `responder` profile 时启动

Docker Compose 快速开始：
以下步骤仅适用于 `deploy/ops` 下的 compose profile。
1. `cp .env.example .env`
2. 设置 `PLATFORM_API_BASE_URL`
3. 启动 caller 模式：`docker compose up -d --build`
4. 后续启用本地 responder：`docker compose --profile responder up -d responder-controller`

Compose API key bootstrap：
1. 启动 `platform-api`
2. 运行 `npm run ops:auth -- register --email you@example.com --platform http://127.0.0.1:8080`
3. 命令会写入 `~/.delexec/.env.local`：
   - `PLATFORM_API_BASE_URL`
   - `CALLER_PLATFORM_API_KEY`
   - `PLATFORM_API_KEY`
   - `CALLER_CONTACT_EMAIL`
4. 若 `caller-controller` 已在运行，请重启使其加载新环境文件

说明：
- 注册 caller 账户后请使用 `CALLER_PLATFORM_API_KEY`
- 面向用户的安装流程应优先统一 `ops` supervisor，而不是直接管理 `responder-controller`
- 目标体验是单一用户控制台：caller 默认开启，responder 为可选角色
- 当前协议基线使用 request-scoped `delivery-meta`（`task_delivery` 与 `result_delivery`）；email 模式结果为纯 JSON body，可带签名 artifact 元数据
