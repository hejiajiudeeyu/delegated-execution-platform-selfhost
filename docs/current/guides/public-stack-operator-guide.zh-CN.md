# 公共栈运维指南

> 英文版：./public-stack-operator-guide.md
> 说明：中文文档为准。

本文档是当前平台栈在公网主机上暴露的运维快速入门。

## 包含内容

`deploy/public-stack` 当前打包：

- `platform-api`
- `postgres`
- `relay`
- `platform-console-gateway`
- 由 `platform-console-gateway` 提供的 `platform-console` 静态 UI
- `caddy` 边缘入口

当你希望使用单一公网入口形态，而不是手动组合 `deploy/platform` 与 `deploy/relay` 时，这是推荐起点。

## 开始前准备

请准备：

- 安装 Docker 和 Docker Compose 的 Linux 主机
- 公网 DNS 名称或稳定公网 IP
- 开放端口 `80` 与 `443`
- PostgreSQL、relay、gateway 数据的持久化卷策略
- 强口令的 `PLATFORM_ADMIN_API_KEY`

运维 surface：

- `platform-console` 静态 UI 已由 `platform-console-gateway` 打包进
  `public-stack`
- 当前栈通过 `/console/` 暴露运维 UI
- 当前栈通过 `/gateway/*` 暴露运维 gateway API

## 快速开始

1. 复制 `deploy/public-stack/.env.example` 为 `deploy/public-stack/.env`
2. 设置：
   - `PUBLIC_SITE_ADDRESS`
   - `PLATFORM_ADMIN_API_KEY`
   - 若拉取已发布镜像，设置 `IMAGE_REGISTRY` 与 `IMAGE_TAG`
     - 使用具体发布标签，例如 `v0.1.x`；首次公网安装不要依赖 `latest`
     - release workflow 只会在 `v*` release tag 上发布 `latest`
     - 可用以下命令查询已发布标签：
       `curl -fsS https://ghcr.io/v2/hejiajiudeeyu/rsp-platform/tags/list`
3. 启动栈：

```bash
docker compose -f deploy/public-stack/docker-compose.yml --env-file deploy/public-stack/.env up -d
```

4. 验证公网健康：

```bash
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/healthz"
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/platform/healthz"
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/relay/healthz"
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/gateway/healthz"
curl -fsS "${PUBLIC_SITE_ADDRESS%/}/console/"
```

## 公网路由

- `/platform/*` -> `platform-api`
- `/relay/*` -> `relay`
- `/gateway/*` -> `platform-console-gateway`
- `/console/*` -> `platform-console-gateway` 提供的静态控制台资源

## Bootstrap 与可见性默认值

当前默认偏生产：

- `ENABLE_BOOTSTRAP_RESPONDERS=false`
- 不暴露预先批准的演示 responder

如果你需要预置演示角色，请使用 `deploy/all-in-one`，不要把 `public-stack` 改造成演示 profile。

## 运维启动检查清单

栈健康后：

1. 打开 `${PUBLIC_SITE_ADDRESS%/}/console/`
2. 初始化 gateway 本地密钥存储
3. 通过 gateway 会话流程写入 `PLATFORM_ADMIN_API_KEY`
4. 验证一次认证代理调用成功
5. 创建或批准首个真实 responder 与 hotline
6. 确认在 responder 与 hotline 都 `approved + enabled` 前，目录保持为空

最小 gateway 流程：

```bash
BASE="${PUBLIC_SITE_ADDRESS%/}"
TOKEN=$(curl -fsS -X POST "$BASE/gateway/session/setup" \
  -H 'content-type: application/json' \
  -d "{\"passphrase\":\"change-me-now\",\"bootstrap_secret\":\"$PLATFORM_CONSOLE_BOOTSTRAP_SECRET\"}" | jq -r '.token')

curl -fsS -X PUT "$BASE/gateway/credentials/platform-admin" \
  -H 'content-type: application/json' \
  -H "x-platform-console-session: $TOKEN" \
  -d "{\"api_key\":\"$PLATFORM_ADMIN_API_KEY\"}"

curl -fsS "$BASE/gateway/proxy/v2/admin/hotlines" \
  -H "x-platform-console-session: $TOKEN"
```

## 冒烟验证

建议检查：

- 部署配置解析：
  - `npm run test:deploy:config`
- source-build 的公共栈冒烟：
  - `npm run test:public-stack-smoke`
- published-image 冒烟：
  - 运行 `Published Images Smoke` 工作流

`public-stack-smoke` 会验证：

- 边缘入口健康
- platform / relay / gateway 路由健康
- 打包的 `/console/` 路由可达
- gateway 会话初始化
- 通过 gateway 持久化 admin 凭据
- 至少一个代理 admin API 调用

本仓库当前默认镜像命名空间：

- `ghcr.io/hejiajiudeeyu`

public-stack 镜像集合为：

- `rsp-platform`
- `rsp-relay`
- `rsp-gateway`

这三个 GHCR package 必须设为 public，匿名 operator 才能拉取。
`rsp-caller` 与 `rsp-responder` 不属于 public-stack 发布路径，只在遗留/内部 compose profile 中被引用。
