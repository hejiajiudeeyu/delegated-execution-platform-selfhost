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
- `caddy` 边缘入口

当你希望使用单一公网入口形态，而不是手动组合 `deploy/platform` 与 `deploy/relay` 时，这是推荐起点。

## 开始前准备

请准备：

- 安装 Docker 和 Docker Compose 的 Linux 主机
- 公网 DNS 名称或稳定公网 IP
- 开放端口 `80` 与 `443`
- PostgreSQL、relay、gateway 数据的持久化卷策略
- 强口令的 `PLATFORM_ADMIN_API_KEY`

当前限制：

- `platform-console` 前端尚未打包进 `public-stack`
- 当前栈通过 `/gateway/*` 暴露运维 gateway API

## 快速开始

1. 复制 `deploy/public-stack/.env.example` 为 `deploy/public-stack/.env`
2. 设置：
   - `PUBLIC_SITE_ADDRESS`
   - `PLATFORM_ADMIN_API_KEY`
   - 若拉取已发布镜像，设置 `IMAGE_REGISTRY` 与 `IMAGE_TAG`
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
```

## 公网路由

- `/platform/*` -> `platform-api`
- `/relay/*` -> `relay`
- `/gateway/*` -> `platform-console-gateway`

## Bootstrap 与可见性默认值

当前默认偏生产：

- `ENABLE_BOOTSTRAP_SELLERS=false`
- 不暴露预先批准的演示 seller

如果你需要预置演示角色，请使用 `deploy/all-in-one`，不要把 `public-stack` 改造成演示 profile。

## 运维启动检查清单

栈健康后：

1. 初始化 gateway 本地密钥存储
2. 通过 gateway 会话流程写入 `PLATFORM_ADMIN_API_KEY`
3. 验证一次认证代理调用成功
4. 创建或批准首个真实 seller 与 subagent
5. 确认在 seller 与 subagent 都 `approved + enabled` 前，目录保持为空

最小 gateway 流程：

```bash
BASE="${PUBLIC_SITE_ADDRESS%/}"
TOKEN=$(curl -fsS -X POST "$BASE/gateway/session/setup"   -H 'content-type: application/json'   -d '{"passphrase":"change-me-now"}' | jq -r '.token')

curl -fsS -X PUT "$BASE/gateway/credentials/platform-admin"   -H 'content-type: application/json'   -H "x-platform-console-session: $TOKEN"   -d "{"api_key":"$PLATFORM_ADMIN_API_KEY"}"

curl -fsS "$BASE/gateway/proxy/v1/admin/subagents"   -H "x-platform-console-session: $TOKEN"
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
- gateway 会话初始化
- 通过 gateway 持久化 admin 凭据
- 至少一个代理 admin API 调用

本仓库当前默认镜像命名空间：

- `ghcr.io/hejiajiudeeyu`
