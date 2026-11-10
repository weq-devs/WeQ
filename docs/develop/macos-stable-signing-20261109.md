# macOS 固定签名身份（2026-11-09）

## 实现

正式 macOS 构建使用同一张长期自签 code-signing 证书，应用标识仍为 `app.weq.desktop`。
公开证书在 `resources/signing/macos-release.pem`，两种指纹在
`apps/desktop/src/shared/mac-signing.json`；主进程与独立安装助手将固定 requirement 编译进产物。
不新增权限助手能力、不迁移数据库访问、不修改 TCC。自签不等于 Developer ID 或公证。

`WEQ_MAC_SIGNING_MODE=self-signed` 要求专用钥匙串；自定义签名钩子直接指定公开证书 SHA-1，
不依赖 electron-builder 25 的 valid identity 筛选。逐文件 hardened runtime / entitlements 保留，
关闭自动 entitlement / provisioning profile 处理，自签不请求时间戳。
未指定模式的开发包保留既有签名选项；`adhoc` 显式选择临时签名；未知模式或正式模式缺料报错。

发布签名检查包含严格递归验证、bundle ID、实际叶证书 SHA-1/SHA-256，以及准确的固定证书 DR。
不能仅根据 `Authority` 名称或 `codesign --verify` 的成功判定身份。ZIP 解压后再检查一次。

所有 macOS 更新均走官方 Release SHA-256/大小核验、同卷暂存、退出提交和独立助手原位替换。
不再用 ad-hoc 与否决定 Squirrel 分流。旧宿主仍验证完整签名和版本；新候选在准备、助手就绪、
实际替换前均验证本版本编译进来的发布 requirement，安装计划不能替换信任锚。
首次从 ad-hoc 迁入可能需要一次重新授权，后续是否可读仍由实际宿主的 `checkQqDataAccess` 判定。

## 证书与 CI

一次性生成入口：`node scripts/create-macos-signing-identity.mjs <新的专用目录>`。
默认凭据目录为 `~/Library/Application Support/WeQSigning/release`，目录 0700，私钥、P12 和密码
文件 0600；私钥 PEM 也加密。已有目录不覆盖。证书及私钥不得在每次发布时重新生成。
脚本创建独立钥匙串，不将其加入用户搜索列表；本机验证结束后锁定该钥匙串。

仓库 secrets：`CSC_LINK` 为该目录 `identity.p12` 的 base64，`CSC_KEY_PASSWORD` 为 `password`
文件内容。只把公开证书与指纹纳入 Git，不把凭据放进 Actions artifact 或日志。
当前本地身份须配置为与源码公开证书一致，不能复用此前 `/tmp/weqsign-test` 的测试身份。

两个 macOS release job 先运行 `prepare-macos-signing.mjs`，显式导入并检查证书，输出
`CSC_KEYCHAIN` 给打包步骤；该步骤不再接收 CSC_LINK，避免 builder 再次导入或自动选择身份。
专用钥匙串的自动锁定窗口设为 6 小时，结束时 always 清理；密码错误和指纹不符均中止，
错误不转发可能带密码的 security 命令参数。ZIP 检查失败会阻止草稿公开。

**专用钥匙串必须进用户搜索列表**：`codesign` 是按用户搜索列表找身份的，只传
`--keychain <路径>` 并不保证能命中，证书、私钥、partition list 都齐也会报
`The specified item could not be found in the keychain`（2.5.3 的 x64 / arm64 发布就是这样
在第一个 codesign 上挂掉的）。所以 prepare 会在导入后把钥匙串追加进搜索列表、把原始列表存到
签名目录，cleanup 先还原列表再删钥匙串；导入完还会真签一个探针文件并 `codesign --verify`，
身份不可用时在准备阶段就报错，而不是打包到一半。

本机配置或更新 secrets 时，直接从上述凭据文件通过 stdin 交给 `gh secret set`，不要打印 base64
或在命令行中展开密码。已登录且可访问仓库后运行
`node scripts/configure-macos-signing-secrets.mjs`，它先检查公开证书与仓库访问，再通过 stdin 配置两个 secrets。
换证书必须另做身份迁移：先发布能接受新身份的更新器，再切换签名；
现有更新器不会接受未经安排的新证书。

## 验证

```bash
pnpm --filter @weq/desktop test test/mac_signing.test.ts test/mac_update.test.ts test/mac_update_install.test.ts test/app_updater.test.ts test/qq_data_access.test.ts test/mac_update_native.test.ts
node --test scripts/macos-signing-release.test.mjs
pnpm --filter @weq/desktop typecheck:node
CSC_KEYCHAIN='<专用钥匙串>' node scripts/smoke-macos-signing.mjs /Applications/weQ.app
```

最后一项仅 APFS clone 既有 Electron 框架与启动壳，创建两份内容/版本不同的最小 Electron app，
调用真实签名钩子，检查 cdhash 不同、DR 相同、固定 requirement 匹配、实际启动版本和 ZIP 签名。
不复制整个工程、不运行 WeQ 业务、不读取 QQ、不以 Terminal 下的启动冒充 TCC 验收；结束清理夹具。
原生更新回归用一次性合成证书和编译进测试助手的固定指纹，不要求生产私钥。

`codesign -R` 的内联 requirement 参数必须以 `=` 开头；先断言旧包能通过自己的 requirement，
再测试另一个包是否匹配，避免把“参数被误当作文件名”当作签名拒绝。

FDA 验收另行进行：在隔离 macOS 环境中，从实际应用宿主读取受保护夹具，第一版只授权一次，
随后原位更新第二版并验证无需重授；重启隔离系统后再次读取，更换证书作反例。
不能直接修改 TCC 数据库，也不能把 DR 稳定、应用启动、文件版本或设置开关当作成功依据。
需要完整 x64 Electron/native 发布资产的打包和运行验收，与合成 Mach-O 的架构检查分别记录。

## 本轮状态

源码接入与本地凭据创建完成，迁回原工作区 `/Users/wata4me/Projects/weq-devs/WeQ` 的 `dev` 分支；
临时工作区已删除，其他任务改动保留。当前 `/Applications/weQ.app` 和 FDA 未修改。
原工作区复跑 6 份专项测试共 53 项通过，包含真实 codesign、独立安装助手、arm64/x64 合成 Mach-O。
发布链 4 项测试、主进程类型检查和针对性 Biome 检查通过；正式 P12 的本地 CI 导入与清理也验证通过。

两份最小完整 Electron 44.10.0 arm64 包均完成固定证书签名、真实启动和 ZIP 解压签名验证。
版本 1.0.0 的 cdhash 为 `7f81fde7421ef0553b3a315cfa236cfbe7cd8279`，1.1.0 为
`a83e7f6655059d36b2e2be606be08dbabd7a0c84`，两者 DR 均为固定叶证书 requirement。
没有将该结果冒称整个 WeQ 业务、QQ 数据读取或 x64 Electron 发布包的运行验收。

GitHub secrets 查询返回 HTTP 401，尚未配置 CI secrets，未运行云端发布、未推送。
尚未执行完整产品及 x64 Electron/native 发布资产打包，不用安装版业务模块冒充这些资产。
FDA 跨更新/系统重启验收尚未执行，不能声明“一劳永逸已验收”。

依据：[Apple TCC 与稳定 DR](https://developer.apple.com/forums/thread/834560)、
[Apple TN2206](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)。
