# Rename And Local State Migration Map

本文件冻结本轮 `@delexec` rename 与本地状态迁移的执行面。

## 已定稿目标

- npm scope: `@delexec`
- CLI 包: `@delexec/ops`
- CLI 可执行名: `delexec-ops`
- JWT issuer: `delexec-platform-api`
- 本地目录: `~/.delexec/`
- SQLite 文件名: `delexec.sqlite`
- 兼容环境变量窗口: `DELEXEC_HOME` 为主，`CROC_OPS_HOME` 为旧名兼容

## 执行面

- `package.json` 包名与 workspace 依赖
- 源码 import / export 路径
- 服务 bin 名与 packaged-e2e 启动命令
- README、部署文档、Codex onboarding、env 示例
- JWT `iss` claim 与规范示例
- 本地状态目录与本地 SQLite 默认文件名
- Codex 相关默认工作目录和本地状态路径约定

## 兼容窗口

- `croc-ops` 作为兼容 bin 暂时保留，但正式文档只写 `delexec-ops`
- `CROC_OPS_HOME` 作为旧环境变量兼容保留，但 `DELEXEC_HOME` 为正式变量
- 默认路径会把 `~/.remote-subagent/` 自动迁移到 `~/.delexec/`
- 旧 `croc.sqlite` 会在目标目录内自动迁移为 `delexec.sqlite`

## 扫描规则

- 旧命名只允许保留在本文件、命名矩阵和历史规划文档中
- 运行时代码、测试、当前文档和 CI 不允许再出现旧 scope、旧 CLI 名、旧目录名或旧 issuer
