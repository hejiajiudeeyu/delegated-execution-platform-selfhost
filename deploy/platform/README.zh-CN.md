# 平台部署

> 英文版：./README.md
> 说明：中文文档为准。

1. `cp .env.example .env`
2. 至少设置：
   - `TOKEN_SECRET`
   - `PLATFORM_ADMIN_API_KEY`
   - 若拉取已发布镜像，设置 `IMAGE_REGISTRY` / `IMAGE_TAG`
   - 当平台需要下发 relay-backed delivery metadata 或执行隐藏审核测试时，设置 `TRANSPORT_BASE_URL`
3. `docker compose up -d --build`
4. 检查 `http://127.0.0.1:${PORT:-8080}/healthz`

该 profile 会在单机部署 `platform-api` + PostgreSQL。

重要默认值：

- `deploy/platform` 面向生产，默认 `ENABLE_BOOTSTRAP_SELLERS=false`
- 默认 **不会** 暴露预批准演示 seller，除非你显式开启
- 若用于本地/演示 bootstrap seller，建议改用 `deploy/all-in-one`，或显式设置：
  - `ENABLE_BOOTSTRAP_SELLERS=true`
  - `BOOTSTRAP_SELLER_ID`
  - `BOOTSTRAP_SUBAGENT_ID`
  - `BOOTSTRAP_TASK_DELIVERY_ADDRESS`
