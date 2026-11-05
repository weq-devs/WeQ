# SIP 开启下 QQ 调试副本接入

日期：2026-11-05。实现范围：桌面签名、读取顺序、用户级副本管理与进程归属检查。
版本号不变，未发布或替换已安装 WeQ/权限助手。

## 读取契约

- WeQ 主进程的 `build/entitlements.mac.plist` 保留 electron-builder 默认运行权限，
  增加 `com.apple.security.cs.debugger`；不向渲染子进程追加调试权，也不给 WeQ 增加
  `get-task-allow`。QQ 副本保留原 entitlement，只追加后者。
- 只重签主程序，不带 `--deep`，嵌套组件保留原始签名与权限。将主程序 entitlements
  递归应用到 Helper 会丢失 `com.apple.security.inherit`，导致沙盒初始化崩溃；即便
  递归重签时保留权限，也会改变 Helper 的 Team ID，导致 Renderer 无法加载原团队
  签名的热更新 QQNT 框架。两类失败均在本机系统日志核实，与开发宿主是否签名无关。
- 管理标记记录 `signingVersion: 1`；旧标记仍识别为 WeQ 管理的副本，但需重新准备，
  不再将旧递归签名副本报告为可启动。
- `attach_elevation.ts` 在 SIP 开启时依次尝试主进程读取、现有长期助手。
  非权限错误原样返回；权限路径均不可用才给副本引导，不再提前拒绝，也不尝试无效 sudo。
- 数据库扫描已先走主进程；扫描失败后长期助手仍可尝试，SIP 判断移到临时 sudo 之前。
- 不更改账号/pid 缓存和在线能力验收规则，重启后的新 pid 沿用原有重新读取机制。

## 副本事务与 UX

`QqDebugCopyManager` 只写用户目录内固定的 `Applications/QQ-WeQ.app`，不接受 IPC 传入任意
源/目标路径。源来自已有 QQ 安装检测。使用系统 `plutil` 解析 plist、`cp -cR` 建立 APFS clone。
标记在暂存副本签名前写入 Resources，与签名一起校验。新副本签名与校验完成后才替换旧副本；
替换失败回滚，回滚自身失败保留恢复资产。事务结束清理本次暂存，不积累历史 bundle。

状态只读接口与动作分离，固定动作 prepare/verify/launch/remove；目录锁阻止多个 WeQ
实例同时操作，运行进程按可执行文件路径识别，不停原 QQ 或其他任务进程。异常退出后遗留
锁明确报路径，不自动猜测其他进程是否已完成。Web 不提供该本机管理流程。

账号选择页、账号设置、受限详情复用同一组件；持续显示检查/复制/签名/校验/启动阶段。
读取端权限、副本签名、进程存在、账号凭据是不同事实，不用启动成功冒称完整功能恢复。
启动按钮只取决于副本就绪、未运行和无在途操作，不以 `readerReady` 为前置条件。
开发 Electron 宿主可能没有 `com.apple.security.cs.debugger`，此时仍可启动副本并登录；
读取端状态继续如实显示未就绪，不将启动成功视为已获得读取权限。移除使用与其他操作一致的图标文字按钮。
参考 WCDA 的阶段式反馈与手动启动检查思路，不复用其登录期捕获或原安装替换流程：
[WCDA macOS 捕获说明](https://github.com/LifeArchiveProject/WeChatDataAnalysis/blob/main/docs/MACOS_KEY_CAPTURE.md)。

## 抓包归属

核对当前 nt_helper 实现：macOS 原生权限助手编译路径通过 PKTAP `ProcessGuard` 过滤目标
PID，原生启动返回链路类型 149 或 258；普通 `.node` 和旧助手没有这一能力。
账号自动抓包验证返回类型；旧组件启动的会话由既有 `CaptureOwnership` 异常清理路径停止，
提示修复长期授权。固定端口保留作显式诊断，不冒称全连接覆盖，也不把 14000 写成全局默认。

## 针对性验证

- `attach_sip.test.ts`：SIP 下直接成功、助手兜底、权限拒绝和非权限错误反例。
- `key_scan_sip.test.ts`：扫描失败后的助手兜底、中英文权限拒绝与无效 sudo 阻断。
- `qq_debug_copy.test.ts`：源保真、创建/更新/签名失败、运行中保护、未知应用、锁和清理。
- `qq_debug_copy_native.test.ts`：合成 Mach-O app 上真实 APFS clone/plutil/codesign；不读 QQ。
- `qq_debug_copy_ui.test.ts`：阶段、失败重试、不误报就绪、重复操作和移除确认。
- `capture_process_scope.test.ts`、`mac_signing.test.ts`：抓包旧组件及签名配置契约。
- `test/browser/run-qq-debug-copy.mjs`：浏览器合成状态，检查深浅/系统主题、主题色、背景、
  桌面/窄屏和减少动态效果。可用 `WEQ_PLAYWRIGHT_IMPORT`、`WEQ_BROWSER_EXECUTABLE` 复用本机工具。

前置研究的 100/100 帧仅是目标 MSF 连接的 15 分钟样本。产品接入测试不把它当正式包、
全部业务、长期稳定性或所有 QQ/macOS 组合的实机验收。

## 本轮回执

- 13 个针对性测试文件共 158 项通过，包含合成 app 的真实系统签名与 APFS clone。
- 浏览器 36 组主题/主题色/背景/宽度组合通过，另检查真实账号选择页的三个宽度副本弹窗；
  检查了截图、长路径换行、创建/启动状态、运行中保护和减少动态效果。
- 主进程类型检查通过。整包类型检查的最后一次尝试受并行导出任务的
  `MailExportPane.tsx` 重复导入 `SegmentedControl` 影响；未改该任务文件。
- 首次主/预加载/界面构建完成；最后一次重建同样被上述导出页面解析错误阻断。
  解包构建还遇到既有 Radix 悬空依赖链接，以及开发清单含 workspace 依赖的打包问题；
  未将前置编译或合成 app 验证写成完整 WeQ 包验收。
- 未修改版本号、未发布、未替换已安装 WeQ 或权限助手，未启动/退出用户 QQ；
  本轮没有把正式签名包在真实 QQ 上重新验收。

## 副本启动修复回执

同日后续核实：旧递归签名副本的 Helper 丢失沙盒继承；保留权限递归重签仍会使
Renderer 加载热更新框架时报 Team ID 不匹配。最终改为只重签主程序，嵌套组件不变。

- 真实系统签名回归夹具增加独立 Helper 权限与可执行文件逐字节保真断言。
- 3 个相关测试文件共 30 项通过，主进程类型检查与改动文件 Biome 检查通过。
- 已用产品管理器重新准备本机副本并启动，主进程、Helper、Renderer 持续运行，
  未新增崩溃报告；原 QQ 进程保留。本次未做账号登录、凭据读取或在线业务验收。
