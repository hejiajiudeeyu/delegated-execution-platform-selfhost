# 当前收尾检查清单

> 英文版：./current-closeout-checklist.md
> 说明：中文文档为准。

本清单用于跟踪：在当前实现被视为“产品化、可部署基线”之前仍需完成的工作。

当前规划说明：
- 本清单面向运维侧 platform baseline
- 它不是 `delexec-ops` 首次上手的当前优先路径
- 本地优先的 client 管理闭环可以独立于这里的剩余事项先行完成

补充口径：
- 当前仓库已经可以作为 `Protocol v0.1 + Caller/Responder/Platform 参考实现 + local transport 双端示例` 的发布基线。
- 本清单剩余项面向“productized, deployable baseline”意义上的完全收官，不等同于首版协议闭环是否成立。

## 状态标记

- `done`：已在当前仓库实现
- `partial`：已有轻量/原型实现，但尚未完整
- `todo`：仍未完成

## 部署与分发

- `done`：`platform`、`relay`、`caller`、`responder`、`ops`、`all-in-one` 的独立部署 profile
- `done`：通过 `deploy/ops` 形成统一的终端用户包形态
- `done`：responder 终端用户安装路径定义为仓库内 `npm run ops -- ...`，与 Docker 部署 profile 分离
- `partial`：真实部署 relay 已接线，compose smoke 对网络/镜像仓库鉴权/镜像拉取失败分类更好，但严格冒烟仍依赖外部镜像拉取稳定性
- `done`：版本化镜像的 registry 发布工作流
- `done`：已发布镜像兼容矩阵与发布说明纪律

## 身份与访问控制

- `done`：caller 注册
- `done`：responder 注册
- `done`：caller 可在同一用户路径启用 responder 角色
- `done`：平台操作的 admin key 与 admin 角色门控
- `done`：本地 API-key bootstrap 命令可将 caller 凭据写入 `.env.local`
- `partial`：角色模型已存在，但仍是最小实现，尚未完全产品化
- `done`：`ops-console` 已有基于口令的本地登录/会话流
- `done`：浏览器不再直接存储平台 admin key；`platform-console` 改为使用本地 gateway 与短期会话
- `done`：`~/.delexec/secrets.enc.json` 本地加密密钥存储
- `partial`：凭据已支持本地加密，但尚未接入 OS keychain / 托管密钥系统

## 平台运维能力

- `done`：responder/hotline 管理员列表
- `done`：responder/hotline 的 approve/reject/enable/disable 操作
- `done`：request 管理员列表
- `done`：角色、审核、禁用动作审计轨迹
- `done`：审核队列端点与控制台视图
- `done`：platform console 已对接这些 API，并提供 reviewer 指引、备注与历史/下钻摘要
- `done`：运行时资源状态简化为 `enabled / disabled`
- `done`：审批生命周期迁移至 review records，而非资源状态本身
- `partial`：审批历史 UX 仍可加强，但 reviewer 备注、指引与历史工作流已就位

## Caller 与 Responder 运维能力

说明：
- 本节反映的是共享实现时期的跨面状态
- 当前 caller / responder 首次上手主路径应以 `delegated-execution-client` 为准
- 不应把这里的条目理解为“本地 client onboarding 必须先经过 platform 审核”

- `done`：caller 远程请求入口
- `done`：caller 后台收件与事件同步循环
- `done`：responder 后台收件与心跳循环
- `done`：caller/responder 共享控制台 MVP
- `done`：ops console 支持注册、responder 启用、dispatch、setup wizard 指引及更丰富结果/运行时视图
- `done`：responder 本地配置路径 `~/.delexec`
- `done`：统一 ops 客户端支持 setup/start/status/add-hotline/submit-review/enable-responder/doctor
- `done`：本地 supervisor 可管理终端用户路径中的 caller、responder、relay
- `done`：更丰富的 request 时间线与结果视图
- `done`：引导本地运行时 setup 与 responder 启用的 onboarding wizard
- `done`：CLI 与 UI 均支持可编辑的 responder/hotline 资料管理

## 搜索与发现

- `done`：目录支持 `task_type`、`capability`、`tag` 过滤
- `done`：公开目录默认只展示已启用 hotline
- `partial`：已具备搜索，但候选排序仍较基础
- `todo`：按可用性、成功率、时延、信任与成本提示做排序
- `todo`：更丰富搜索维度（领域、输入模式、合规标签）

## 可观测性

- `done`：健康检查端点
- `done`：指标汇总端点
- `done`：审计轨迹端点
- `partial`：控制台可见性已包含运行时卡片、服务日志、告警与调试快照，但尚非时间序列可观测
- `todo`：Prometheus 就绪指标
- `todo`：Tracing
- `todo`：结构化日志聚合指引
- `todo`：可直接用于仪表盘的时间序列视图

## 测试与验证

- `done`：主协议路径的单元、集成、e2e 套件
- `done`：部署配置验证
- `partial`：compose smoke 现会预热必需镜像，并区分仓库鉴权/镜像拉取/运行时回归；但外部 Docker 仓库不稳定仍可能阻塞
- `done`：CI 已有发布镜像验证
- `partial`：UI 回归覆盖已有控制台 view model 与生产构建，但未覆盖完整浏览器工作流

## L0 退出建议最小门槛

在宣告 L0 收官前，建议至少完成：

1. 在非易波动外部环境中，稳定地对已发布镜像执行 compose smoke
2. key 轮换与吊销
3. 超越“仅控制台可见”的可观测性能力
