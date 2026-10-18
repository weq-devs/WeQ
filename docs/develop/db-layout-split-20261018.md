# QQ 数据库布局与标准 SQLite 的双进程拆分（2026-10-18）

## 背景

QQ NT 的 SQLCipher 库在文件开头有 1024 字节自定义头。WeQ 早期用 offset VFS
透明跳过这 1024 字节，但没有处理 SQLite 的 `pending_byte`（pager 保留页），
导致一个只在 1 GiB 以上才暴露的问题：

- 标准 SQLite 的保留页是 `262145`，文件偏移 `0x40000000`；
- QQ 库整体右移 1024 字节后，保留页落到 `262144`，偏移 `0x3FFFFC00`；
- 旧实现仍按标准布局打开，于是把 `262144` 页当成可用页、把 `262145` 当成保留页，
  1 GiB 以上的 QQ 库会被误判为损坏（典型报错：`2nd reference to page 262145`、
  `Page 262144: never used`）。

实测 Android 大库的保留页同样是 `262144`，所以 QQ layout 是固定值，不做运行时探测。
QQ 自身的 OS 文件锁仍然落在绝对偏移 `0x40000000`，因此 **pager 保留页**与
**锁字节**必须分开配置。

## 关键约束

`sqlite3PendingByte` 是 SQLite amalgamation 里的进程级全局量，不是连接级参数：

- 同一进程不能安全地混用 QQ layout 和标准 layout；
- `worker_threads` 共享进程地址空间，不能用来隔离两个 layout；
- 必须在打开任何数据库之前选定 layout，之后禁止切换。

## 方案

### 1. patch 掉 SQLCipher 的 pending byte

nt_helper vendor 了 `libsqlite3-sys 0.30.1`，在
`vendor/libsqlite3-sys/sqlcipher` 上打 WeQ patch：

- `PENDING_BYTE` 仍由 `sqlite3_test_control(SQLITE_TESTCTRL_PENDING_BYTE)` 控制，
  QQ layout 设为 `0x3FFFFC00`；
- 新增 `SQLITE_TESTCTRL_LOCK_PENDING_BYTE`，OS 锁路径（`os_unix.c` /
  `os_win.c` / AFP / WinCE）统一使用固定的 `0x40000000`；
- 这样 pager 按 QQ 页号工作，同时和运行中的 QQ 客户端锁在同一段字节上。

nt_helper 暴露 `setDbLayout('qq' | 'standard')` / `getDbLayout()`；
带密钥的 SQLCipher 路径会 `ensure_layout(Qq)`，在打开连接前完成初始化。

### 2. 两个进程，两条 lane

- **主进程**：启动时固定 `qq`。所有 `*WithKey`（SQLCipher 高频查询、健康检查、
  密钥校验、解密、修复）都在这里，不付 IPC 代价。
- **standardDbWorker**：独立子进程，固定 `standard`。所有无密钥的
  `executeSql` / `executeSqlWrite` / salvage 走这里。
- `close*` / `clearQuarantinedTables` 双发，保证两边缓存的句柄都被释放。

路由规则在 `apps/desktop/src/main/db/lane.ts`，按方法名而不是按文件猜：
带 key 的一律主进程，无 key 的一律标准子进程。

### 3. 解密产物仍然是 QQ layout

`fastDecryptDatabase` / `safeDecryptDatabase` 的产物虽然已经是明文，但页号没有
重排，保留页仍是 `262144`。调用方必须在解密后调用主进程 router 的
`markQqLayout(outPath)`：

- 当前会话记在内存 Set；
- 同时写一个空的 `<outPath>.weq-qq-layout` sidecar，跨重启后仍能识别；
- 之后对这条路径的无 key 查询继续走主进程 QQ lane。

不要在标准 SQLite 里直接打开这些产物，否则 1 GiB 以上仍会报 malformed。

## 验证

- Linux 运行中的 QQ：`/proc/<pid>/fdinfo` 的锁区间为
  `0x40000002..0x400001FF`，确认锁字节没有被 QQ layout 带偏。
- 1.1 GiB 真实样本：QQ layout 下 `PRAGMA integrity_check = ok`，
  `checkDatabaseHealth` 正常；同一产物用标准 sqlite 打开会报保留页冲突。
- 端到端：fast 解密 → `markQqLayout` → 无 key 查询命中主进程；小标准库查询命中
  子进程；`db_decrypt` 的 worker_threads 解密在 QQ layout 下成功。

## 平台状态

`os_unix.c` / `os_win.c` / AFP / WinCE 的锁路径都已 patch，但当前只在 Linux
实测过锁字节。Windows / macOS 需要在真机上再验一次，尤其是存在运行中 QQ
实例时的锁冲突。

## 旧版误修复库的布局迁移（2026-10-18 追加）

旧版修复在 1 GiB 以上的 QQ 库上可能把 standard 页布局写进带 QQ 头的产物。为了把这种
库迁回 QQ 布局，`recoverDatabase` 增加了两个可选参数：

- `sourceLayout: 'qq' | 'standard'`（默认 `qq`）；
- `targetLayout: 'qq' | 'standard'`（目前只接受 `qq`）。

迁移的判据只有两个，且只在用户进入「妙妙工具 → 数据库修复」并选中库时执行：

1. 文件大于 1 GiB；
2. 第 `262144` / `262145` 页的状态：`262144` 有数据且 `262145` 全零 → standard，
   需要迁移；反之为 QQ，不迁移；其它组合不提示。

检测读原始字节，不经过 SQLite，也不查旧修复记录。服务层实现在
`packages/service/src/account/db_repair/layout_migration.ts`。

### native 侧如何做到

迁移不能靠切换进程级 `pending_byte`（同一进程禁止切换），也不能让 recover 用
`PRAGMA page_count` 去猜。nt_helper 在明文中间件上做了三件事：

1. **显式页数**：`sqlite3_recover_config` 新增 op `790`，把扫描得到的页数直接交给
   recover，覆盖 `recoverPageCount()`；
2. **按逻辑页号取页**：recover 的取页函数 `nt_recover_page(pgno)` 由调用方注册，
   物理偏移 = `base_offset + (pgno - 1) * page_size`。明文中间件 `base_offset = 0`，
   所以 standard 源的逻辑页号就是它在明文文件里的页号；
3. **目标布局固定 QQ**：重建后的明文仍由 QQ 布局进程加密并补回源库的 1024 字节头，
   产物保留页因此回到 `262144`。

`sourceLayout` 与 `targetLayout` 会回显在 `RecoverReport` 里。WeQ 服务层在替换前核对
`standard → qq`；旧 native 产物会静默忽略未知参数、不回显这两个字段，因此会被拦下，
源库不会被替换。

### 验证

- nt_helper 单测 `standard_source_migrates_to_qq_layout`：standard 源迁移后自检通过、
  行数一致、QQ 头原样保留。
- 真实 1.1 GiB 样本：用旧二进制「修坏」后，standard 布局在 QQ 布局下报
  `layout_padding` 损坏；迁移后 `PRAGMA integrity_check = ok`，跨 `262144` 页的数据
  可读。
- WeQ 单测覆盖检测判据、迁移参数透传、记录类型与旧产物拦截；界面只在修复页选中库时
  发起检测，不在启动时自动跑。
