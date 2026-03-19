# 产品就绪边界

> 英文版：./product-readiness-boundary.md
> 说明：中文文档为准。

本文档定义当前边界：

- `pilot-ready`：可在受控自托管环境中使用
- `production-ready`：可作为稳定、可直接部署的产品基线

## 当前定位

当前仓库状态：

- 对受控自托管场景已 `pilot-ready`
- 尚未 `production-ready`

当前优势：

- 协议主链路已实现
- 已有公共运维栈
- 已有正式 seller/subagent onboarding 与隐藏审核测试

## Pilot-Ready 的含义

当前已支持：

- 带管理员审批的受控 seller/subagent onboarding
- 基于 `deploy/platform`、`deploy/public-stack`、`deploy/relay` 的自托管部署
- source-build 运维栈验证
- 面向 GHCR 的已发布镜像冒烟验证

适配场景：

- 内部评估
- 协议接入
- 演示
- 运维在环的小规模自托管试点

## 尚未达到 Production-Ready

以下事项仍阻碍更强的生产承诺：

1. 密钥生命周期不完整
   - API key 轮换与吊销尚未完成
   - signer key 轮换窗口尚未完成
2. 可观测性不完整
   - 尚无 Prometheus 就绪指标
   - 尚无 tracing
   - 尚无可直接用于 dashboard 的时间序列视图
3. 密钥管理仍以本地优先
   - 当前基线使用本地加密文件
   - 尚无 OS keychain 或托管密钥后端
4. 已支持发布镜像，但外部环境长期稳定性仍需更多 burn-in
5. `platform-console` 前端尚未打包进 `deploy/public-stack`

## 当前对用户的承诺

当前承诺：

- 运维者可通过 Docker Compose 部署公共栈
- 两者都默认假设有具备技术能力的运维者在场

当前不承诺：

- 开箱即用的 SaaS 级托管运维
- 托管式密钥生命周期
- 完整生产级可观测性

## 迈向 Production-Ready 的最小门槛

1. 密钥轮换与吊销
2. Prometheus / tracing / 时间序列可观测性
3. 在真实外部环境中加强已发布镜像验证
4. 更清晰的面向运维者的公共控制台打包形态
