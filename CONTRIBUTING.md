# Contributing to Remote Subagent Protocol

感谢你参与 Remote Subagent Protocol。

本仓库当前处于 MVP 设计与实现早期，贡献目标是快速验证 `Remote Subagent Protocol` 闭环，并打磨首个参考实现，而不是一次性做完整生产系统。

## 1. 贡献范围

欢迎以下类型贡献：
- 文档与接口规范完善（`docs/`）
- Buyer/Seller 参考实现与示例
- Platform Minimal Service（catalog/token/events/metrics）实现
- Playground 交互演示与说明一致性修复
- 测试、可观测性、开发者体验改进

暂不接受：
- 与 MVP 边界无关的大规模重构

## 2. 开发流程

1. 先在 Issue 中认领任务（或新建 Issue 说明问题）。
2. 新建分支：`codex/<scope>-<short-desc>`。
3. 小步提交，保持 PR 可审查（建议 < 400 行净改动）。
4. 提交 PR，关联 Issue，并填写变更说明与验收方式。
5. 至少 1 名维护者 review 通过后合并。

## 3. 提交与 PR 规范

Commit message 建议：
- `feat: ...`
- `fix: ...`
- `docs: ...`
- `refactor: ...`
- `test: ...`
- `chore: ...`

PR 描述至少包含：
- 变更背景（为什么做）
- 变更内容（做了什么）
- 验证方式（如何证明有效）
- 风险与回滚点（如有）

## 4. 文档改动要求

涉及协议/接口/状态机的改动，必须同步更新：
- `docs/l0/architecture.md`
- `docs/l0/platform-api-v0.1.md`
- `docs/l0/integration-playbook.md`

如仅做探索性提案，请先发 ADR 或 Issue 讨论，不直接改主规范。

## 5. 质量门槛

合并前请确保：
- 改动范围聚焦单一目标
- 无明显破坏性变更（除非有明确升级说明）
- 示例 JSON 与文档字段一致
- 新增接口有错误语义说明

## 6. 沟通与响应

- 建议先讨论再改大项。
- 维护者目标响应：
  - 24 小时内首次反馈
  - 72 小时内给出合并/修改建议

## 7. 首次贡献建议

第一次贡献优先从以下任务开始：
- 文档中的字段一致性检查
- Playground 与 API 文档对齐修订
- 新增或修复一个小型示例模板

感谢你的贡献。
