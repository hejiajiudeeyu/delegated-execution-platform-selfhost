# 卖方部署

> 英文版：./README.md
> 说明：中文文档为准。

该 profile 适用于独立服务部署、CI 与高级运维场景。
它不是个人电脑终端用户 responder 安装的默认路径。

终端用户 responder 安装建议走 CLI 路径：

1. `npm install`
2. `npm run ops -- setup`
3. `npm run ops -- auth register --email you@example.com --platform http://127.0.0.1:8080`
4. `npm run ops -- add-hotline --type process --hotline-id local.echo.v1 --cmd "node worker.js"`
5. `npm run ops -- submit-review`
6. `npm run ops -- enable-responder`
7. `npm run ops -- start`

## 独立 Docker Profile

仅在运维托管的独立部署、CI 或本地集成时使用此路径。
该 profile 依赖外部 relay 服务；配套 relay 请见 `deploy/relay`。

1. `cp .env.example .env`
2. 设置 `PLATFORM_API_BASE_URL`、`PLATFORM_API_KEY`、`TRANSPORT_BASE_URL`、`RESPONDER_ID`、`HOTLINE_IDS`
   - 仅当执行器与传输链路可安全并行执行任务时，才将 `RESPONDER_WORKER_CONCURRENCY` 设为大于 `1`
3. `docker compose up -d --build`
4. 检查 `http://127.0.0.1:${PORT:-8082}/healthz`

该 profile 以 SQLite 默认部署 `responder-controller` 独立服务，并依赖外部 relay。
