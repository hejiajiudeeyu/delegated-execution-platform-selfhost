# 公共栈部署

> 英文版：./README.md
> 说明：中文文档为准。

该 profile 是首个面向运维者、用于在公网主机暴露平台的打包方案。

包含组件：

- `platform-api`
- `postgres`
- `relay`
- `platform-console-gateway`
- 由 `platform-console-gateway` 提供的 `platform-console` 静态 UI
- 用于公网入口与 TLS 终止的 `edge`（`caddy`）

## 快速开始

1. `cp .env.example .env`
2. 至少设置：
   - `PUBLIC_SITE_ADDRESS`
   - `TOKEN_SECRET`
   - `PLATFORM_ADMIN_API_KEY`
   - `PLATFORM_CONSOLE_BOOTSTRAP_SECRET`
   - `IMAGE_REGISTRY` / `IMAGE_TAG`
     - 首次公网拉取请使用具体发布标签，例如 `v0.1.x`
     - `latest` 只会在推送 `v*` release tag 时由 Images workflow 发布
     - 可用以下命令查询已发布标签：
       `curl -fsS https://ghcr.io/v2/hejiajiudeeyu/rsp-platform/tags/list`
3. `docker compose --env-file .env up -d`
4. 检查：
   - `GET ${PUBLIC_SITE_ADDRESS%/}/healthz`
   - `GET ${PUBLIC_SITE_ADDRESS%/}/platform/healthz`
   - `GET ${PUBLIC_SITE_ADDRESS%/}/relay/healthz`
   - `GET ${PUBLIC_SITE_ADDRESS%/}/gateway/healthz`
   - `GET ${PUBLIC_SITE_ADDRESS%/}/console/`
5. 继续阅读运维指南：
   - `docs/current/guides/public-stack-operator-guide.md`

## 公网路由

- `/platform/*` -> `platform-api`
- `/relay/*` -> `relay`
- `/gateway/*` -> `platform-console-gateway`
- `/console/*` -> `platform-console-gateway` 提供的静态控制台资源

## 说明

- `deploy/public-stack` 面向生产，默认 `ENABLE_BOOTSTRAP_RESPONDERS=false`
- 如需预置演示角色，优先使用 `deploy/all-in-one`
- gateway 在容器内使用 `DELEXEC_HOME=/var/lib/delexec-ops`，并可从环境变量读取 `PLATFORM_ADMIN_API_KEY`（兼容旧密钥来源）
- 首次调用 `/gateway/session/setup` 时，若调用方非本机或未携带 `PLATFORM_CONSOLE_BOOTSTRAP_SECRET`，会被拒绝
- 该 compose 文件是纯 registry 模式，不依赖本地源码构建上下文
- 该 profile 只拉取 `rsp-platform`、`rsp-relay` 与 `rsp-gateway`；caller/responder 容器镜像属于遗留/内部 profile，不属于 public-stack 主路径
- 首次匿名拉取前，`rsp-platform`、`rsp-relay` 与 `rsp-gateway` 的 GHCR package 必须设为 public
- 对公网 DNS 域名，使用 `PUBLIC_SITE_ADDRESS` 让 `caddy` 完成 TLS 终止
- 冒烟入口：`npm run test:public-stack-smoke`
