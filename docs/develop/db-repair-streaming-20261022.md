# 大库修复的流式解密

## 故障与修复范围

2026-10-22 本机 2.1.0 在迁移约 19 GB 消息库时，原生工作线程于
`recover_database → decrypt_database_at → std::fs::read` 中崩溃。
旧实现同时持有整份密文和整份明文，内存需求约为数据库大小的两倍；
大额分配可能直接终止 Electron，无法依靠 Promise 的异常处理恢复。

nt_helper 本地修复分支 `fix/stream-database-decryption` 的 2.1.1 改为：

- 用固定大小缓冲逐页读取、解密、写出，显式检查最终 flush 的错误。
- 保留盐解析、密钥解释、页大小、reserve 填充和源库物理页序。
- QQ / standard 布局仍由 recover 的显式布局参数解释，不在解密层重排。
- 拒绝输出指向源路径；Unix 下也检查符号链接与硬链接别名，避免截断源库。

这里只降低解密阶段的内存占用，不降低中间文件的磁盘需求，也不改变备份、
原库指纹复核、替换或回滚规则。此本地修复不表示正式 native release 或
`native/pinned.json` 已更新。

## 验证

在 nt_helper 仓库执行：

```sh
cargo test --locked --offline database:: -- --test-threads=1
cargo fmt --check
cargo clippy --locked --offline --all-targets -- -D warnings
node test/test_stream_decrypt.cjs /absolute/path/to/nt_helper.node
```

新增 Rust 测试检查三种页 HMAC 算法、多种头长度、短读、每次读写的页大小上界、
19 GB 虚拟文件的首个页写出与写入失败传播，以及源库别名保护。
现有真实 SQLCipher 小夹具继续覆盖损坏库恢复、严格坏页处理、健康库重建和布局迁移。
两个会写入超过 1 GiB 数据的原有测试仍按其默认配置忽略。

N-API 冒烟使用 64 MiB 合成密文，不接触 QQ 数据。它校验全部输出字节的哈希，
并限制解密阶段的额外进程峰值内存。安装版旧模块在该测试中增加约 128 MiB，
能复现整库双缓冲的问题。临时密文、明文和日志在测试结束时自动删除。

`_cdylib` 是旧 SQLite 扩展入口的条件编译分支，不是产品构建使用的 feature；
直接 `--all-features` 会启用该分支并出现既有接口缺失，不能用它替代默认产品配置的检查。

## 开发版实际加载核验

2026-10-23 04:43（北京时间）开发版再次在旧 `std::fs::read` 路径退出。
加载日志确认使用的是仓库 `native` 目录，而非已热修复的安装版模块。
源码版本、已安装版和开发版原生产物必须分别核验，不能用其中一份的测试代替另一份。

```sh
pnpm native:check-streaming
# 或显式检查将要使用的模块（也可用 ELECTRON_RUN_AS_NODE=1 配合 Electron 运行）
node scripts/check-native-streaming.mjs /absolute/path/to/nt_helper.node
```

默认检查 `WEQ_NATIVE_DIR/<platform>/<arch>/nt_helper.node`，没有覆盖时检查本仓库
`native`。检查只生成 64 MiB 合成密文，校验完整输出哈希及解密额外峰值内存，
结束后清理临时文件，不打开 QQ 原库。旧整库缓冲模块在同一检查中应失败。
本机开发启动器在启动 Electron 前对实际目标运行此检查；失败不启动应用。

同步本地热修复时，必须一起核验模块与装扮 `.dat` 的密钥兼容性，并如实记录
本地覆盖来源；不要将本地模块伪装成 `native/pinned.json` 的正式发布产物。
