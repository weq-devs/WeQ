# 在线账号密钥扫描的大库读取修复

## 原因与边界

北京时间 2026-10-25 20:20:05，开发版主进程在
`scan_key_from_database_with_progress → scan_key_with_progress → std::fs::read`
路径退出。实际加载模块 UUID 与系统崩溃报告一致；目标消息库约 16.38 GiB。
旧扫描入口在打开进程前读取整份过滤数据库，大额原生分配可直接终止 Electron，
不能由路由层的 Promise 异常处理恢复。

`nt_helper` 本地修复版本 2.2.3 仅改变数据库验证输入的读取方式：

- 固定读取 QQ 包装头 1024 字节与首个加密页 4096 字节，共 5120 字节。
- 复用候选校验所用的布局常量，短读补齐，截断与 I/O 错误返回失败。
- 有进度及无进度接口共用同一入口，不改变候选顺序、密钥格式或算法组合。

此处只约束数据库读取，不宣称后续进程内存扫描零开销或已经实现子进程隔离。
用户原库不参与自动测试，不自动重发密钥请求或重启 WeQ。

## 针对性验证

原生仓库 `/Users/wata4me/Projects/nt_helper`：

```sh
cargo test --locked --offline key_scan:: -- --test-threads=1
```

回归覆盖固定读取上界、短读、中断重试、截断、I/O 错误，以及真实 SQLCipher
生成的全部 12 种 page-HMAC × KDF-HMAC 组合。校验读取前缀与完整小夹具的
结果一致，错误密钥不能通过。

WeQ 对实际模块执行：

```sh
pnpm native:check-key-scan
# 或指定候选 nt_helper.node，可配合 ELECTRON_RUN_AS_NODE=1 使用 Electron 运行
node scripts/check-native-key-scan.mjs /absolute/path/to/nt_helper.node
```

脚本先检查 64 MiB 合成稀疏文件的内存增量，超限立即退出，不进入大文件步骤；
通过后才检查 20 GiB 稀疏文件。只写入头部，使用不存在的 PID，不打开真实
QQ 进程。两种接口均检查；临时文件始终清理。旧模块在首个 64 MiB 检查中
增加 66016 KiB 峰值内存并失败，未让旧模块尝试 20 GiB 分配。

本次检查：密钥扫描 13 项测试通过；修改文件的 Rust 格式检查及 WeQ 检查脚本的
Biome 检查通过，`cargo clippy --locked --offline --lib -- -D warnings` 通过。
`--all-targets` 检查被既有 `src/database/sql.rs` 的
`clippy::items_after_test_module` 阻断，未改动或放宽该规则。

## 本地交付

开发版实际使用 `native/darwin/arm64/nt_helper.node`。修复需在该产物上完成
上述检查，并保留流式解密及既有装扮资源兼容性，不能只改 Rust 源码。
本地覆盖来源由忽略入库的 `native/.installed.json` 记录，不改正式
`native/pinned.json`，不冒充远端发布；已经运行的进程需完全退出再打开才会
加载替换后的模块。安装版应用与其他服务不在本次替换范围内。

2026-10-25 本机已构建并替换开发版模块，原生源码提交为 `457aa64`，
未推送。替换后对实际目标再次运行 Electron 检查：64 MiB 有进度扫描的
额外峰值为 480 KiB，20 GiB 两种扫描接口的额外峰值均为 0 KiB
（进程历史峰值增量，不代表绝对零分配）。Node 检查同样通过。
候选模块流式解密 64 MiB 合成密文的内容哈希一致，额外峰值 160 KiB；
font / bubble / widget 的既有资源查询与旧模块一致。
没有在真实账号上自动执行扫描，真实密钥获取成功与否仍需重启后实际验收。
