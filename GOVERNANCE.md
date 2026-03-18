# Governance

## 1. 角色定义

- Maintainer：维护主分支、评审 PR、发布里程碑决策
- Contributor：通过 PR 贡献代码/文档/测试

## 2. 决策原则

优先级从高到低：
1. 安全与正确性
2. MVP 闭环可验证性
3. 开发与接入复杂度
4. 性能与体验优化

## 3. 变更决策机制

以下变更需要先讨论并形成 ADR（Architecture Decision Record）：
- 协议字段变更
- 安全模型变更
- 状态机与重试语义变更
- API 破坏性变更

一般流程：
1. Issue 提案
2. ADR 讨论
3. 达成结论后实施

## 4. 合并权限

- 默认由 Maintainer 合并
- 关键模块（token/security/contract）需要至少 1 名 Maintainer 审核通过

## 5. 模块 Owner（后续）

项目稳定后可按模块设 Owner：
- Buyer
- Seller
- Platform API
- Docs & Playground

Owner 负责对应模块的评审优先级与路线建议，但不绕过 Maintainer 合并规则。
