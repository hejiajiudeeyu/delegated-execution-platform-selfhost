# delegated-execution-platform-selfhost

> 英文版：[README.md](README.md)
> 说明：中文文档为准。

委托执行的自托管平台、中继与运维控制台。

通过 Docker Compose 部署平台，为你的团队或组织提供 Hotline 目录、请求路由、Responder 注册表及运维 Web 控制台。

---

## 快速部署

```bash
# 拉取最新 compose 入口和环境模板
docker compose -f deploy/public-stack/docker-compose.yml up -d
```

复制并编辑环境模板完成配置：

```bash
cp deploy/platform/.env.example deploy/platform/.env
# 编辑 .env，填写域名、密钥和 SMTP 配置
```

---

## Platform Control 控制台

**Platform Control** Web 控制台在部署完成后可通过网关地址访问，为运维人员提供平台健康状态与所有注册实体的实时视图。

![平台概览](docs/screenshots/overview.png)

概览页面展示：

- **Platform API** 可达状态
- 实时指标：总请求数、活跃 Responder、活跃 Hotline、近 1 小时请求数
- **Platform Admin 凭证** — 配置 Admin API Key 以启用完整运维访问权限

---

## Responder 管理

浏览所有已注册的 Responder，查看其状态，并在一个列表视图中完成审批或暂停操作。

![Responder 管理](docs/screenshots/responders.png)

*将 `docs/screenshots/responders.png` 放入截图目录后此处将自动显示。*

---

## Hotline 审核队列

在 Hotline 发布到目录前，先审核入库申请。从 Review 队列中批准或拒绝提交。

![审核队列](docs/screenshots/reviews.png)

*将 `docs/screenshots/reviews.png` 放入截图目录后此处将自动显示。*

---

## Hotline 管理

查看并管理平台上所有已注册的 Hotline，包括其状态、所属方和能力标签。

![Hotline 管理](docs/screenshots/hotlines-admin.png)

*将 `docs/screenshots/hotlines-admin.png` 放入截图目录后此处将自动显示。*

---

## 仓库职责

本仓库负责面向运维人员的自托管部署面：

- 平台 API、Relay、Platform Control 网关及可部署的平台镜像
- Dockerfile、`docker compose` 入口及运维环境模板
- 镜像构建/冒烟工作流及运维部署文档
- 平台侧持久化与服务端集成连接

本仓库不负责协议真实来源定义，也不负责端用户 `delexec-ops` 客户端体验。

## 公开产品面

本仓库面向最终用户的入口是基于 Docker 的部署流程：

- 官方 `docker compose` 入口
- 一份 `.env` 模板
- 一份运维部署指南

仓库内的 npm 包用于构建、测试和镜像组装，不是运维人员的主要安装路径。

## 共享依赖

本仓库消费一小组已发布的共享包：

- `@delexec/contracts`
- `@delexec/runtime-utils`
- `@delexec/sqlite-store`

## 发布模型

- 面向运维人员的主要发布产物：Docker 镜像 + `docker compose`
- 内部开发产物：工作区 npm 包（如 `@delexec/platform-api`、`@delexec/transport-relay`、`@delexec/postgres-store`）

参见：`docs/current/guides/release-surface.md`

## 如何在此仓库开发

- 当变更涉及运维部署、服务端 API、Relay 行为、平台持久化或镜像/compose 交付时，从本仓库开始。
- 保持运维产品边界简洁：主要支持路径是 Docker 镜像 + `docker compose`，而非 npm 安装服务端包。
- 以 `deploy/public-stack`、`deploy/platform`、`deploy/relay` 作为受支持的部署面。

推荐变更流程：

1. 若变更影响协议语义，先更新 `delegated-execution-protocol` 并消费已发布的 `@delexec/contracts`。
2. 在本仓库实现平台与部署变更。
3. 运行平台 CI、包检查、部署配置检查及 public-stack 冒烟测试。
4. 以 Docker 镜像和 compose 产物作为面向运维人员的发布交付物。

通过第四仓库工作区操作时，优先使用顶层 `corepack pnpm install` 加 `corepack pnpm run sync:local-contracts`，再进行跨仓库验证。
