# Public Marketplace 契约

本文档是品牌站 marketplace 公共读模型的唯一真相源。

当前公开前端位于：

- `/Users/hejiajiudeeyu/Documents/Projects/call-anything-brand-site`

当前公共 API 实现位于：

- `/Users/hejiajiudeeyu/Documents/Projects/delegated-execution-dev/repos/platform/apps/platform-api/src/server.js`

## 用途

这些路由只服务于公开目录页面。

它们目前支持：

- 品牌站 marketplace 列表页
- responder profile 页面
- hotline detail 页面

它们不应暴露：

- 管理侧审核备注
- 内部审计载荷
- 仅运营侧可见的字段

## 路由

当前 public marketplace 契约包含：

- `GET /marketplace/meta`
- `GET /marketplace/hotlines`
- `GET /marketplace/hotlines/:hotlineId`
- `GET /marketplace/responders/:responderId`

## 契约规则

- `responder.summary` 表示 responder 自己提供的公开 profile 简介，或由平台运营明确配置的公开简介。
- `responder.summary` 不能由 hotline 数量、审核状态或模板句自动拼接生成。
- 如果 `responder.summary` 缺失，后端可以返回空字符串；前端只允许显示类似“暂无公开简介”的中性占位。
- `GET /marketplace/meta` 只负责聚合统计，不负责补 responder profile 文案。
- `GET /marketplace/hotlines` 可以返回 responder 的列表展示字段，但不应被视为 responder 长简介的真相源。
- `GET /marketplace/hotlines/:hotlineId` 继续作为 hotline 详情页的真相源。

## Responder 公共模型

`GET /marketplace/responders/:responderId`

前端当前已消费且需要稳定的字段：

- `responder_id`
- `responder_slug`
- `display_name`
- `summary`
- `hotline_count`
- `capabilities`
- `availability_status`
- `review_status`
- `support_email`
- `trust_badges`
- `hotlines`

说明：

- `summary` 是用户可见的公开 profile 文案。
- `support_email` 是公开联系方式，可以为 `null`。
- `trust_badges` 是公开信任元数据，可以为空数组。
- `hotlines` 是该 responder 旗下的公开 hotline 列表。

建议继续保持稳定、便于后续扩展的字段：

- `last_heartbeat_at`
- `task_types`

## Hotline 公共模型

`GET /marketplace/hotlines`

前端当前已消费且需要稳定的字段：

- `hotline_id`
- `hotline_slug`
- `responder_id`
- `responder_slug`
- `responder_display_name`
- `display_name`
- `summary`
- `task_types`
- `capabilities`
- `tags`
- `availability_status`
- `trust_badges`
- `template_summary`
- `latest_review_test`
- `updated_at`

`GET /marketplace/hotlines/:hotlineId`

前端当前已消费且需要稳定的详情字段：

- 上述 hotline 列表字段
- `related_hotlines`
- `input_schema`
- `output_schema`
- `template_ref`
- `responder_profile`

说明：

- `summary` 是公开 hotline 简介。
- `related_hotlines` 可以为空。
- `template_summary` 可以为 `null`。
- `latest_review_test` 可以为 `null`。

## 职责边界

前端负责：

- 结构化展示 responder 与 hotline 页面
- 对缺失的可选公共字段做最小中性降级
- 不编造 responder 品牌简介

后端负责：

- 为已审核且可见的条目返回稳定的公共目录数据
- 在 `summary` 中提供 responder 自己的公开简介
- 严格区分 public 字段与 admin/internal 字段
- 未来新增 marketplace 字段时，先更新本文档

## 前端消费位置

当前前端使用方式：

- `/marketplace`
  - 使用 `GET /marketplace/meta`
  - 使用 `GET /marketplace/hotlines`
- `/marketplace/responders/:responderSlug`
  - 在前端解析 slug
  - 使用 `GET /marketplace/responders/:responderId`
- `/marketplace/responders/:responderSlug/:hotlineSlug`
  - 在前端解析 slug
  - 使用 `GET /marketplace/hotlines/:hotlineId`

品牌站部署文档应链接到本文档，而不是重复定义字段语义。
