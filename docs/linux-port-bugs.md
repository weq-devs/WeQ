# WeQ Linux 适配 —— 遗留 BUG 跟踪

> 第二轮排查(探索报告 + 用户实测反馈)。按优先级排,✅=已修 🔧=修复中 ⬜=待修。
> 分支 `feat/linux-adaptation`。

## 核心根因(修一处连带解决多个)

### A. `accountDataDir` 用 `<root>/<uin>`(win 布局) —— global_config.ts:167
Linux 账号目录是 `<root>/nt_qq_<hash>`,不是 `<root>/<uin>`。这是下面第 6/4 类 5+ 处的公共源头。
应改为按平台解析(用 `platform.ntDbDir/ntDataDir(uin)` 或账号目录解析器)。
- ⬜ global_config.ts:167 `accountDataDir`
- ⬜ global_config.ts:241 `dbFileSizes` —— `join(dataDir,'nt_qq','nt_db')` 多一层
- ⬜ global_config.ts:271 `ntDataSubdirSizes` —— `join(dataDir,'nt_qq','nt_data')` 多一层
- ⬜ global_config.ts:297 `accountDirSize`
- ⬜ media_scan.ts:48 `mediaDirsFromAccountDir` —— `join(accountDir,'nt_qq','nt_data')` 导出媒体扫不到

### B. uid 时序 —— 登录取密钥时 uid 不可用 【用户实测:「没找到 xxxx 的数据库目录」】
`fetchKeyFromInstance` 现改用 `platform.ntMsgDbPath(uin)`,linux 需 uid 回调,但登录时账号还没 openAccount,uid 不在 registry。
→ 需要在 `listAccounts` 解密 login.db 拿到 uin+uid 时,就把 uid 灌进 registry(detect service 在 service 层,registry 在 app 层,需打通)。
- ✅ B1 加 `ensureUidForUin(boot, uin)` helper:从 listAccounts 找 uid 灌 registry。
  已接入 fetchKeyFromInstance / testDatabaseKey / openAccount(回退)。bootstrap.ts

### C. `getQqProcesses` 把 Electron 子进程算进去 【用户实测:实例数乱显示】
Linux QQ 是 Electron,一个实例派生 gpu/renderer/utility/zygote 多进程,进程名都是 `qq`。
- ⬜ C1 probeOnline (global_config.ts:207,229) count 虚高 → StatsPanel 在线实例数错
- ⬜ C2 单进程精修分支(:212)永不触发,isQqLoggedIn 归属跳过
- ⬜ C3 LoginPanel `procs.length===1` 启发式失效(取密钥走不到直连)
- 根因在 native getQqProcesses 的 linux 实现(.node 内),需确认是否按主进程去重;否则上层按 ppid/cmdline 收敛

### D. isQqLoggedIn 三处只传 uin(linux 需 baseDir+uid)→ 恒 false
- ⬜ D1 global_config.ts:217
- ⬜ D2 db_decrypt.ts:61
- ⬜ D3 monitor.ts:145

## 其它

### 1. 硬编码 `\` 分隔符
- ✅ types.ts:37 `deriveMsgDbPath` —— 已删(#6 改 fetchKeyFromInstance 走 uin)
- ⬜ SelectScreen.tsx:63,75 `dataDir: \`${root}\\${uin}\`` —— 前端拼账号目录,应只传 uin 让 main 的 accountDataDir 解析

### 2. 纯数字 uin 目录发现 `/^\d+$/`
- ⬜ win32_detect.ts:324 `probeAccountDirs` —— linux fallback 账号列表恒空
- ⬜ global_config.ts:186 `countUserDataDirs` —— linux 本地账号数恒 0
  (用户反馈 #2:本地账号个数统计要用 nt_qq_xxx 不要纯数字)

### 5. QQ 版本侦查 【用户反馈 #1】
- ⬜ global_config.ts:140,302 `parseQqVersion` 正则抽 `versions/<ver>/`,linux 扁平路径匹配不到 → 版本恒 null
  正解:读 `<qqRoot>/resources/app/package.json` 的 version。win 也可统一改这个(用户:应该一样)
- ⬜ linux/paths.ts:34 注释说读 versions/config.json,与"读 package.json"矛盾,需澄清

### 目录大小 【用户反馈 #3】
- ⬜ 见 A(dbFileSizes/ntDataSubdirSizes 去掉 nt_qq 中间层)

### QQ 实例个数 【用户反馈 #4:setting.json 里有实例数,现在乱显示,可能算了子进程】
- ⬜ 见 C。另外 `~/.config/QQ/versions/setting.json` 可能有权威实例数,待确认能否用

### ninebird 落盘成功但等不到 dbkey 回调 【用户反馈 #5】
- ✅ **E1 根因找到并修复:appid/qua 从未接线**。loader 兜底 appid `537246140` ≠ 本机真实
  `537376497`(从 major.node 抠),后端 140022017 拒绝登录 → 收不到 0xcde_2 包 → 等不到
  回调 → 超时回退扫码(又弹一次 pkexec,被误解为落盘失败)。
  修复:Platform 加 `qqMajorNodePath()`(win/linux),Win32KeyService 新增 `resolveAppidQua()`
  调 `resolveAppidFromMajor` 解析真实值,传给 startQuickLogin/startQrLogin。已 typecheck 验证
  本机解析出正确 appid=537376497 qua=V1_LNX_NQ_3.2.31_51102_GW_B。**待实测登录确认**。
- ⬜ E2 dropStub 落盘前应先检查文件已存在且内容一致,避免重复 pkexec
- ⬜ E3 ninebird 无本地日志,排查困难 → 需要加日志

### pkexec 体验 【用户反馈 #5】
- ⬜ 落盘前查重(见 E2);回退扫码前不应再次无意义 pkexec

## 已完成
- ✅ #6 fetchKeyFromInstance 改走 uin(main 用 platform 解析),删前端 deriveMsgDbPath —— 但触发了 B(uid 时序)
