# 中继部署

> 英文版：./README.md
> 说明：中文文档为准。

1. `cp .env.example .env`
2. `docker compose up -d --build`
3. 检查 `http://127.0.0.1:${PORT:-8090}/healthz`

该 profile 用于部署 buyer/seller controller 共享的传输 relay 服务。
