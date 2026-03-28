# Cross-Repo Compatibility Testing

本文件定义预拆分阶段的跨仓验收测试形态。

目标不是继续依赖 monorepo 内部源码 import，而是逐步把全链路测试切到“独立进程 + HTTP + 已发布产物”模式。

## 当前原则

- unit / integration 仍由各实现仓各自负责
- e2e / compatibility 测试必须把服务当作边界外部件启动
- 测试交互只走 HTTP、CLI、compose，不走源码级 server factory import

## 当前 e2e 启动模型

当前 [tests/e2e](/Users/hejiajiudeeyu/Documents/Projects/remote-hotline-protocol/tests/e2e) 已改成独立进程启动：

- platform
- relay
- caller
- responder
- ops supervisor

默认情况下，测试会回退到当前仓库内的源码入口。

但现在已经支持通过环境变量覆盖启动命令，从而优先消费已安装包或外部命令。

仓库内还提供了一条 tarball 启动检查：

- `npm run test:service:packages`
- `npm run test:e2e:packages`

这条检查会：

- `npm pack` platform / caller / responder / relay
- 在空目录安装 tarball
- 直接启动各自的 bin
- 验证 `/healthz`

`npm run test:e2e:packages` 会在此基础上继续：

- 把这些已安装 tarball 入口注入 `E2E_*_CMD` / `E2E_*_ARGS`
- 实际运行整套 `test:e2e`
- 验证 e2e 可以在“已安装产物优先”模式下通过

## 环境变量约定

每个服务都可以通过两类环境变量覆盖：

- `E2E_<SERVICE>_CMD`
- `E2E_<SERVICE>_ARGS`

支持的 service 名：

- `PLATFORM`
- `RELAY`
- `CALLER`
- `RESPONDER`
- `OPS_SUPERVISOR`

`*_ARGS` 既可以是 JSON 数组，也可以是空格分隔字符串。

示例：

```bash
E2E_PLATFORM_CMD=delexec-platform-api
E2E_PLATFORM_ARGS='[]'
E2E_RELAY_CMD=delexec-relay
E2E_CALLER_CMD=delexec-caller-controller
E2E_RESPONDER_CMD=delexec-responder-controller
E2E_OPS_SUPERVISOR_CMD=delexec-ops
E2E_OPS_SUPERVISOR_ARGS='["start"]'
npm run test:e2e
```

这条路径的设计目标是：

- 本地开发时默认仍可从源码入口跑通
- 一旦 client / platform 仓开始发布 tarball 或 npm 包，同一套 e2e 可以直接切到已发布二进制入口

## 推荐分层

1. 仓内测试  
   unit / integration，跟随源码

2. 发布产物 e2e  
   启动已安装包、已打包 CLI 或外部命令，只走 HTTP / CLI

3. 镜像级 compatibility  
   拉发布镜像，用 compose 跑完整验收

## 当前限制

- 当前还没有把 `platform` / `caller` / `responder` 做成 clean-room 可独立 npm 安装的公开分发物
- 因此 `E2E_*_CMD` 的主用途还是为本地 tarball、临时安装目录、外部包装脚本留接口
- 真正的“发布包优先”要等 client/platform 仓的分发闭环完成后再切为默认模式
