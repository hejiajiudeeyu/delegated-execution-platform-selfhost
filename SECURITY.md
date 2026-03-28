# Security Policy

## 1. 支持范围

当前重点覆盖：
- Token 签发与校验（`/v1/tokens/*`）
- 目录与公钥分发（`/v1/catalog/*`）
- 请求事件与指标接口（`/v1/requests/*`, `/v1/metrics/*`）
- Caller/Responder 合约与结果包校验逻辑

## 2. 漏洞上报

请不要在公开 Issue 直接披露安全漏洞细节。

请优先使用 GitHub Private Vulnerability Reporting（PVR）私下报告：
- Report a vulnerability: `https://github.com/hejiajiudeeyu/remote-hotline-protocol/security/advisories/new`


## 3. 上报内容建议

请尽量包含：
- 影响范围与前置条件
- 复现步骤
- PoC（可选）
- 预期影响（数据泄露/越权/重放等）
- 修复建议（可选）

## 4. 响应时效目标

- 24 小时内确认收到
- 72 小时内给出初步分级与处理路径
- 修复完成后协商披露时间

## 5. 披露流程

- 默认采用协调披露（Coordinated Disclosure）。
- 在修复发布前，不公开复现细节与利用代码。
- 修复发布后，可在双方确认后公开技术细节。

## 6. 当前已知风险（MVP）

- 邮件通道不保证端到端加密，Token 存在理论截获面
- v0.1 以在线 introspect 为主，平台可用性会影响responder 验权
- v0.1 为 ACK-only 事件模型，排障精度有限

以上风险属于文档已声明的 MVP 取舍，不代表可以忽略安全问题。
