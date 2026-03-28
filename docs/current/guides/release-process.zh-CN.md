# 发布流程

> 英文版：./release-process.md
> 说明：中文文档为准。

本仓库使用最小化的自托管平台发布流程。

## 目标

- 为 `platform`、`gateway`、`relay` 产出版本化容器镜像
- 在 source-build 与 published-image 两种模式下验证面向运维者的 `public-stack` compose 路径
- 在保证可重复性的前提下，将 L0 发布门槛保持精简

## 镜像标签

推荐标签：

- 不可变标签：git SHA
- 发布标签：`vX.Y.Z`
- 可选滚动标签：在发布标签上打 `latest`

## CI 期望

- `CI` 运行平台通道及 source-build 的 `public-stack` compose 冒烟
- `Published Images Smoke` 面向 GHCR，用于验证已发布镜像
- `Images` 在 PR 上构建发布镜像，并可在 release tag 或手动触发时推送
- `CI` 会检查当前仓库版本是否存在对应发布说明和兼容矩阵条目

## 推荐发布步骤

1. 打版本标签，如 `v0.1.0`
2. 运行平台集成检查
3. 运行打包服务检查，确认 `platform-api` 与 `relay` tarball 在 clean room 中可安装并启动
4. 运行 source-build 的 `public-stack` 冒烟，确认运维入口链路可用
5. 让 `Images` 工作流发布 `rsp-platform`、`rsp-gateway`、`rsp-relay`
6. 确认 `docs/archive/releases/vX.Y.Z.md` 存在，且 `docs/archive/releases/compatibility-matrix.md` 已包含该标签
7. 确认对应的 `Published Images Smoke` 在 GHCR 路径通过
8. 将外部部署环境更新到发布的 `IMAGE_TAG`
9. 确认当前就绪边界仍与 `docs/current/guides/product-readiness-boundary.md` 一致

## Compose 冒烟失败分类

- `image_pull_failed`：基础镜像或 registry/network 拉取问题
  - 包括 Docker Hub 认证/token 获取失败，如 `failed to fetch oauth token`、`failed to authorize`，或镜像解析期间 registry EOF
- `port_conflict`：本地端口分配冲突
- `compose_up_failed`：通用 compose 启动失败
- `service_runtime_failed`：容器已启动但进入 `unhealthy/exited/restarting`
- `health_check_timeout`：服务未在时限内变为健康
- `postgres_crud_check_failed`：数据库启动成功但基础 CRUD 失败
- `register_failed` / `catalog_failed` / `caller_remote_request_failed` / `ack_not_ready` / `caller_result_not_ready`：业务路径回归

## 兼容性说明

对于 L0，兼容性以仓库发布版本级别跟踪：

- 一个仓库版本对应一组镜像标签
- 暂不承诺混合版本部署
- 兼容矩阵记录于 `docs/archive/releases/compatibility-matrix.md`

## 运维发布边界

本仓库是 compose-first：

- 主要运维产物是 `deploy/public-stack/docker-compose.yml`
- 本仓库 npm 包用于构建和验证，不是主运维安装路径
- 镜像矩阵为 `rsp-platform`、`rsp-gateway`、`rsp-relay`
