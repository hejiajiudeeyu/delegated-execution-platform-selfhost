# 备份与恢复

`scripts/stack-backup.mjs` 负责 `public-stack` 数据面的备份、校验与恢复。除 Docker
外，被操作的主机上不需要装任何东西。

```bash
node scripts/stack-backup.mjs backup  --project public-stack --out ~/backups/delexec
node scripts/stack-backup.mjs verify  --backup ~/backups/delexec/<stamp> --deep
node scripts/stack-backup.mjs restore --backup ~/backups/delexec/<stamp> --project <target>
```

## 备份包含什么

| 有状态面 | 归档为 | 丢了会怎样 |
|---|---|---|
| PostgreSQL | `postgres.sql.gz`（`pg_dump`） | 调用、设备、热线、账本、告警配置全部消失 |
| Artifact 字节 | `artifacts.tar.gz` | 已提交的 artifact 仍以带 checksum 的描述符存在，但取不到字节 |
| Gateway `DELEXEC_HOME` | `gateway.tar.gz` | console 的加密凭据存储消失，只能走 bootstrap 重置 |
| Relay sqlite | `relay.tar.gz` | 在途任务信封消失，相关调用需重投 |

PostgreSQL 一律走 dump，绝不复制数据卷——运行中的数据目录不能安全归档。relay 的
sqlite 按崩溃一致性复制（db 加 `-wal`、`-shm`），sqlite 打开时会重放 WAL。

## 备份刻意不包含什么

**`.env`**。里面是 `TOKEN_SECRET`、`PLATFORM_ADMIN_API_KEY`、`RELAY_ADMIN_TOKEN`、
`RELAY_TOKEN_SECRET`、`PLATFORM_CONSOLE_BOOTSTRAP_SECRET`。把它塞进每一份备份，等于
成倍增加这些密钥的存在位置，而备份是会被到处拷贝的。自己单独加密保管，与备份放在一起
但**不放在里面**。

同样不含：主机 nginx 配置、TLS 证书、容器镜像（按 `manifest.json` 记录的 tag 从
registry 拉取）。

即便如此，备份本身仍是密级材料——dump 里有 API key，gateway 归档里有加密凭据存储。
文件以 `0600` 写入 `0700` 目录。

## 备份远程主机

`--docker` 会给每次 docker 调用加前缀，因此远程栈上不需要部署任何代码：

```bash
node scripts/stack-backup.mjs backup --project public-stack \
  --out ~/backups/delexec --docker "ssh aliyun-ecs sudo -n docker"
```

参数会经过远程 shell 再解析一次，所以这种用法要求任何参数都不含空格——脚本自己构造的
参数都不含。

## 校验

`verify` 检查 manifest、每个文件的大小与 sha256，然后是这个工具存在的理由：**数据库里
每一条 `committed` 的 artifact，都必须有字节、大小对得上、sha256 对得上**。平台在
checksum 不符时拒绝把 artifact 标为已交付；一份悄悄丢掉字节的备份，等于把同一个谎言
挪到下一层重说一遍。有字节但数据库无记录的，报 warning 而非 blocker。

`verify --deep` 会额外把 dump 灌进一个一次性 PostgreSQL，并从中重新导出 artifact
索引。**这是唯一能判定 dump 究竟能不能加载的检查**——文件在不在、checksum 对不对，只
证明字节完好，完全不能证明 PostgreSQL 会接受它。它还会把 dump 里的索引与 manifest 对
比，可捕捉「dump 与归档不是同一时刻状态」的情况。

真正要依赖的备份，至少跑一次 `--deep`。

## 恢复

```bash
node scripts/stack-backup.mjs restore --backup <dir> --project <target>
```

恢复会拒绝写入已有数据的卷，并指名是哪个卷挡住了。演练请用全新 project 名；`--force`
会覆盖并销毁现有内容。

它恢复三个归档卷，并把 dump 灌入新建的 PostgreSQL 卷（创建口令为
`stack-backup-restore`）。带上你自己的 `.env`，让 `DATABASE_URL` 与该口令一致（或起栈
后改口令），然后：

```bash
docker compose -p <target> -f deploy/public-stack/docker-compose.yml --env-file .env up -d
```

## 用全新密钥恢复时会发生什么

在新主机上现生成一份 `.env` 是可行的，但有几条后果值得在出事之前就知道：

- **console 是「锁着」而不是「未初始化」**。`GET /gateway/session` 报
  `configured: true, setup_required: false, locked: true`，这就是凭据存储确实回来了的
  判据。若报 `setup_required: true`，说明 gateway 归档没恢复成功。
- **console 里存的 operator API key 是旧的**。它是上一套部署加密存进去的，而平台现在
  认你带来的 `.env` 里的 `PLATFORM_ADMIN_API_KEY`——所以解锁 console 后要重录 admin key。
- **已签发的 relay receiver token 全部失效**，因为它们由 `RELAY_TOKEN_SECRET` 做 HMAC
  签名。设备需要重新取 token。
- **已签发的任务 token 同理失效**（`TOKEN_SECRET`）。它们短命，只影响在途调用。

带上原始 `.env` 可以避免以上全部四条。

## 关于 `PLATFORM_ADMIN_API_KEY`

2026-08-06 之前，只要栈已有持久化状态，`.env` 里的这个 key 就被静默忽略：hydration 会
用快照里的那份整体替换 API key 表，于是只有「数据库第一次为空时烧进去的那把」还能通过
认证。后果有两条——恢复出来的栈没法用运营者手上真正持有的 `.env` 去管理；轮换这个 key
是个看起来生效、实际什么也没发生的空操作。现在，**显式配置的 key 胜过快照并吊销上一
把**；未配置则一切照旧——回退值每次启动随机生成，否则每次重启都会把还在用的 key 吊销掉。

## 演练

恢复流程只有演练过才算数。2026-08-06 那次演练——把生产快照恢复到另一台机器，六件
artifact 全部经恢复后的平台取回且 checksum 一致——记录在四仓
`.trellis/tasks/08-05-daily-usability-sprint/unit-3-backup-restore.md`。
