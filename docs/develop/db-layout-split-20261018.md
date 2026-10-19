# QQ 数据库布局：按文件设置保留页（2026-10-18，2026-10-19 重写）

## 背景

QQ NT 的 SQLCipher 库在文件开头有 1024 字节自定义头。WeQ 早期用 offset VFS
透明跳过这 1024 字节，但没有处理 SQLite 的 `pending_byte`（pager 保留页），
导致一个只在 1 GiB 以上才暴露的问题：

- 标准 SQLite 的保留页是 `262145`，文件偏移 `0x40000000`；
- QQ 库整体右移 1024 字节后，保留页落到 `262144`，偏移 `0x3FFFFC00`；
- 旧实现仍按标准布局打开，于是把 `262144` 页当成可用页、把 `262145` 当成保留页，
  1 GiB 以上的 QQ 库会被误判为损坏（典型报错：`2nd reference to page 262145`、
  `Page 262144: never used`）。

QQ 自身的 OS 文件锁仍然落在绝对偏移 `0x40000000`，所以 **pager 保留页**与
**锁字节**必须分开：pager 按文件头平移，锁字节不动。

## 为什么不再拆进程

第一版实现走的是 `sqlite3_test_control(SQLITE_TESTCTRL_PENDING_BYTE)`，而
`sqlite3PendingByte` 是 amalgamation 里的**进程级全局量**。代价是同一进程不能
混用 QQ 布局与标准布局，于是主进程固定 `qq`、标准库放进 `standardDbWorker`
子进程，每条无 key SQL 都要付 IPC。

2026-10-19 起 nt_helper 把这个值降成了 **per-Pager / per-BtShared**：

- `struct Pager` / `struct BtShared` 各带一个 `pendingByte`；
- `PENDING_BYTE_PAGE(pBt)`、`lckPgno`、`backup.c` 的跨页复制都读各自的值；
- 新增 `SQLITE_FCNTL_PENDING_BYTE`（opcode 46），打开连接后按文件设置一次；
- 锁路径完全不参与，仍用固定的 `0x40000000`。

因此同一个进程可以同时打开 QQ 库、标准库和解密产物，**不再需要子进程**。

## 布局如何确定

nt_helper 的 `src/database/file_layout.rs` 从文件头推导：

1. 前 16 字节是 `"SQLite header 3\0"`：QQ 自描述头，紧随其后 2 字节大端给出
   `size / 256`（正常是 `04 00` → 1024）。`pending = 0x40000000 - size`。
2. 否则 `[32..40]` 是 `QQ_NT DB` / `Guild DB`：旧版 QQ 库，按 1024 处理。
3. 其余（含 `SQLite format 3\0`）一律是标准布局。

无头但保持 QQ 页号的文件（旧版解密产物）无法从内容区分，调用方需要显式传
`layout: 'qq'`。新版本解密产物已经改为标准布局，正常流程用不到这个参数。

## 解密产物

`fastDecryptDatabase` / `safeDecryptDatabase` 现在都产出**标准布局**的明文库
（保留页 262145），可以直接被任何 SQLite 工具打开。`fast` 只用于 512 MiB
以下的文件，页数远低于 1 GiB 边界，页号无差别；`safe` 的 ATTACH 目标显式设成
standard。

因此不再有 `markQqLayout`、`.weq-qq-layout` sidecar，也没有 QQ/standard 两条
lane 的路由表。

## 验证

- nt_helper 单测：同一进程同时打开标准库与 QQ 库，交替查询互不串页。
- 1 GiB+ 测试（`#[ignore]`）：用 QQ 布局创建的真实库跨过 262144 页后
  `integrity_check = ok`；同一文件用标准布局打开会报 262144/262145 冲突。
- 真实 1.1 GiB 样本（`nt_msg.db`，272,249 页）：`checkDatabaseHealth` 正常，
  `integrity_check = ok`，`group_msg_table` 1,079,930 行；显式 `standard` 布局
  复现 `database disk image is malformed`。
- Linux 运行中的 QQ：`/proc/<pid>/fdinfo` 的锁区间仍为
  `0x40000002..0x400001FF`，确认锁字节没有被布局带偏。

## 平台状态

锁路径未改动，沿用上游实现。Windows / macOS 仍建议在真机上确认存在运行中 QQ
实例时的锁冲突行为。

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

迁移不能靠切换进程级 `pending_byte`，也不能让 recover 用
`PRAGMA page_count` 去猜。nt_helper 在明文中间件上做了三件事：

1. **显式页数**：`sqlite3_recover_config` 新增 op `790`，把扫描得到的页数直接交给
   recover，覆盖 `recoverPageCount()`；
2. **按逻辑页号取页**：recover 的取页函数 `nt_recover_page(pgno)` 由调用方注册，
   物理偏移 = `base_offset + (pgno - 1) * page_size`。明文中间件 `base_offset = 0`，
   所以 standard 源的逻辑页号就是它在明文文件里的页号；
3. **按布局设置保留页**：输入明文连接按 `sourceLayout` 设置，recover 的输出库通过
   新增的 op `791`（`SQLITE_RECOVER_PENDING_BYTE`）设置成 `targetLayout`。

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
