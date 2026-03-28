# 部署指南

> 英文版：./deployment-guide.md
> 说明：中文文档为准。

本指南覆盖当前面向运维者的自托管平台部署形态。

当前协议/运行时基线：

- platform 返回 request-scoped 的 `delivery-meta`，包含 `task_delivery` 与 `result_delivery`
- responder 结果邮件使用纯 JSON body；caller-controller 在上游暴露前会先解析并校验
- 文件输出可通过签名的 `artifacts[]` 作为附件传输
- `platform_inbox` 预留给未来演进，当前部署未实现

## 推荐安装路径

- 面向运维部署：优先 `deploy/public-stack`
- 低层服务部署：使用 `deploy/platform` 与 `deploy/relay`
- 终端用户客户端安装已不属于本仓库关注范围

## 支持的 Profile

- `deploy/public-stack`：推荐的运维栈
- `deploy/platform`：platform API + PostgreSQL
- `deploy/relay`：共享传输 relay

Profile 意图：

- `deploy/public-stack` 是主要运维 bundle
- `deploy/platform` 是更低层的控制面 profile
- `deploy/relay` 是更低层的传输 profile

## 遗留 / 内部 Profile

以下 profile 仍保留用于历史本地联调与内部验证，但不是主要运维产品表面：

- `deploy/ops`
- `deploy/caller`
- `deploy/responder`
- `deploy/all-in-one`

## 镜像分发

每个受支持部署 profile 都接受：

- `IMAGE_REGISTRY`
- `IMAGE_TAG`

默认镜像名：

- `rsp-relay`
- `rsp-platform`
- `rsp-gateway`

## 平台管理员访问

如果你希望本地 `platform-console-gateway` 使用稳定运维凭据，请在平台部署里设置 `PLATFORM_ADMIN_API_KEY`。

- `platform-console` 只应访问 `platform-console-gateway`
- `platform-console-gateway` 应使用 `PLATFORM_ADMIN_API_KEY`
- caller 凭据不再隐含运维权限
- 用户仍可通过 admin role-grant 接口后续授予 `admin` 角色
- 浏览器不应直接持久化运维 API key；它存储于本地加密密钥仓，并由 gateway 注入
- `deploy/platform` 应明确传入：
  - `PLATFORM_ADMIN_API_KEY`
  - 当需要 relay-backed `delivery-meta` 时传 `TRANSPORT_BASE_URL`
  - 当隐藏审核测试走独立 relay 路径时传 `REVIEW_TRANSPORT_BASE_URL`

当前 compose 文件同时保留 `image` 和 `build`，便于本地 source build。在 registry 环境中，请把 `IMAGE_REGISTRY` 与 `IMAGE_TAG` 指向已发布镜像。

本仓库当前默认镜像命名空间：

- `ghcr.io/hejiajiudeeyu`

## 公共栈

当你希望使用单一运维入口并暴露公网时，推荐从 `deploy/public-stack` 开始。

当前首版包含：

- `platform-api`
- `postgres`
- `relay`
- `platform-console-gateway`
- `caddy` 边缘入口

当前公网路由：

- `/platform/*`
- `/relay/*`
- `/gateway/*`

完整运维启动流程见 `docs/current/guides/public-stack-operator-guide.md`。

建议的冒烟验证拆分：

- source-build 运维路径：`npm run test:public-stack-smoke`
- published-image 运维路径：运行 `Published Images Smoke`

## Relay

relay 是平台侧栈使用的共享传输运行时。

- 隐藏审核测试若设置 `REVIEW_TRANSPORT_BASE_URL` 则使用该地址，否则 platform 回退到 `TRANSPORT_BASE_URL`
- relay 可通过 `RELAY_SQLITE_PATH` 使用 SQLite 持久化
- `local://relay/<receiver>/...` 投递地址会解析到 relay receiver

## Responder 签名密钥

在本地演示中 responder 签名可选；在非演示部署中应视为必需。

请同时配置：

- `RESPONDER_SIGNING_PUBLIC_KEY_PEM`
- `RESPONDER_SIGNING_PRIVATE_KEY_PEM`

规则：

- 不要只提供其中一个；密钥对不完整会导致启动失败
- 在 `.env` 中使用转义换行编码多行 PEM
- 优先通过运行时平台注入密钥，不要把 PEM 提交到环境文件

示例：

```env
RESPONDER_SIGNING_PUBLIC_KEY_PEM=-----BEGIN PUBLIC KEY-----
...
-----END PUBLIC KEY-----
RESPONDER_SIGNING_PRIVATE_KEY_PEM=-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----
```

对于 `platform` bootstrap 模式，对应变量为：

- `ENABLE_BOOTSTRAP_RESPONDERS`
- `BOOTSTRAP_RESPONDER_PUBLIC_KEY_PEM`
- `BOOTSTRAP_RESPONDER_PRIVATE_KEY_PEM`
- `BOOTSTRAP_RESPONDER_API_KEY`
- `BOOTSTRAP_TASK_DELIVERY_ADDRESS`

当 `platform` 与 `responder` 分离部署时，请在两侧使用同一 responder 身份和同一密钥对。
面向生产的 `deploy/platform` 建议默认禁用 bootstrap responder，除非你明确在运行预置演示环境。

## 部署建议

- `platform`：以服务端镜像发布/部署，并接入托管 PostgreSQL
- `public-stack`：需要单一公网运维入口时优先使用
- `caller`：同时支持容器部署与直接嵌入；若希望标准化运维，使用 Docker
- `responder`：终端用户机器优先 `npm run ops -- ...`，运维托管的独立服务再使用容器部署

## 发布形态

推荐镜像标签模型：

- 不可变标签：git SHA
- 可读标签：发布版本，如 `0.1.0`
- 可选渠道标签：`latest`

推荐发布顺序：

1. 发布共享测试结果
2. 发布 `rsp-platform`、`rsp-caller`、`rsp-responder`
3. 将部署示例更新为发布的 `IMAGE_TAG`
