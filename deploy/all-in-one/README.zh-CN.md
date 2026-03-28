# 一体化部署

> 英文版：./README.md
> 说明：中文文档为准。

1. `cp .env.example .env`
2. `docker compose up -d --build`
3. 检查：
   - `http://127.0.0.1:8080/healthz`
   - `http://127.0.0.1:8081/healthz`
   - `http://127.0.0.1:8082/healthz`

该 profile 会同时启动 PostgreSQL、platform、caller、responder，适用于本地联调和演示。
当前运行时行为使用 request-scoped `delivery-meta`；在 email 模式下，responder 返回纯 JSON 结果体，文件产物可作为附件由 caller-controller 校验。
