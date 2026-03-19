# 买方部署

> 英文版：./README.md
> 说明：中文文档为准。

1. `cp .env.example .env`
2. 将 `PLATFORM_API_BASE_URL` 设置为你的平台地址
3. 将 `TRANSPORT_BASE_URL` 设置为你的 relay 地址
4. `docker compose up -d --build`
5. 检查 `http://127.0.0.1:${PORT:-8081}/healthz`

该 profile 以 SQLite 默认部署 `buyer-controller` 独立服务，并依赖外部 relay 服务。
