# 发布面说明

> 英文版：./release-surface.md
> 说明：中文文档为准。

本仓库面向运维者的表面是 Docker 镜像与 `docker compose`。

## 主要产品表面

常规运维者应通过以下方式使用本仓库：

- 已发布 GHCR 镜像
- `deploy/public-stack/docker-compose.yml`
- `deploy/platform/docker-compose.yml`
- `deploy/relay/docker-compose.yml`

## 内部 npm 包

本仓库仍包含一些 workspace 包，例如：

- `@delexec/platform-api`
- `@delexec/transport-relay`
- `@delexec/postgres-store`

这些包用于支持：

- 仓库内构建
- 服务包冒烟检查
- 镜像组装与验证

它们不是运维者的主安装路径。

## 发布策略

1. 涉及协议变更时，先发布 `@delexec/contracts`。
2. 升级本仓库消费的已发布共享依赖。
3. 发布 `rsp-platform`、`rsp-gateway`、`rsp-relay` 的 GHCR 镜像。
4. 通过 source-build 与 published-image 冒烟验证对应 compose 路径。

## 开发规则

在决定将体验和文档投入在哪里时，优先优化 compose 驱动的运维流程，而不是 npm 安装平台服务。
