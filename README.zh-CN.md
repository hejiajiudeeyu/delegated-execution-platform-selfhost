# 项目说明

> 英文版：./README.md
> 说明：中文文档为准。

delegated execution 的自托管平台、relay、部署配置与运维表面。

本仓库包含从原 monorepo 拆分出来的平台侧应用与自托管部署材料。

## AI 协作

- `CLAUDE.md` 定义仓库专属的开发与验证规则。
- `AGENTS.md` 给 AI 编码代理提供最小路由与职责摘要。

## 对外产品表面

本仓库面向终端用户的入口是 Docker 驱动的部署流程：

- 官方 `docker compose` 入口
- 一份 `.env` 模板
- 一份运维部署指南

仓库中的内部 npm 包用于构建、测试和镜像组装，不是运维者的主安装路径。

## 仓库职责

本仓库负责面向运维者的自托管部署表面：

- platform API、relay、platform console gateway 与可部署平台镜像
- Dockerfile、`docker compose` 入口与运维环境模板
- 镜像构建/冒烟工作流与运维部署文档
- 平台侧持久化与服务端集成装配

本仓库不负责 protocol 真相源，也不负责终端用户 `delexec-ops` 客户端体验。

## 共享依赖

本仓库消费少量已发布共享包：

- `@delexec/contracts`
- `@delexec/runtime-utils`
- `@delexec/sqlite-store`

## 发布模型

- 主要面向运维者的发布产物：Docker 镜像 + `docker compose`
- 内部开发产物：workspace npm 包，例如 `@delexec/platform-api`、`@delexec/transport-relay`、`@delexec/postgres-store`

另见：`docs/current/guides/release-surface.md`

## 在这里如何开发

- 当改动影响运维部署、服务端 API、relay 行为、平台持久化或镜像/compose 交付时，从本仓库开始。
- 保持运维产品边界简单：主支持路径是 Docker 镜像 + `docker compose`，不是 npm 安装服务包。
- 将 `deploy/public-stack`、`deploy/platform`、`deploy/relay` 视为受支持部署面；遗留 profile 次之。

建议改动流程：

1. 若改动协议语义，先更新 `delegated-execution-protocol` 并消费新发布的 `@delexec/contracts`。
2. 在本仓库实现平台与部署改动。
3. 运行平台 CI、包检查、部署配置检查与 public-stack 冒烟。
4. 以 Docker 镜像与 compose 产物作为面向运维者的交付物发布。
