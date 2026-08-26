# macOS NineBird：入口补丁 + 进程内 hook

> 机制照抄 [napcat-mac-installer](https://github.com/NapNeko/NapCat-Mac-Installer)（已在生产环境验证），
> hooker 本体来自 `nt_helper/ninebird/hooker/macos`（进程内 Mach-O 扫描 + dyld hook）。

## 为什么 macOS 不需要注入型 native addon

Windows / Linux 的 `ninebird_addon.node` 是"启动器"：CreateProcess 远程线程 / fork + LD_PRELOAD，
把 hook 介质塞进 QQ 进程。macOS 上这套东西被 SIP 卡死，但 QQ 是 Electron 应用，有更干净的等价入口：

1. QQ 的 `package.json.main` 决定 Electron 启动时执行哪个 JS；
2. 把 `main` 指向容器里的 `loadNineBird.js`（需要管理员权限改 `/Applications/QQ.app`）；
3. loader 按 `--no-sandbox` 参数决定走 NineBird 还是原版启动器（与 napcat 同一个约定）；
4. NineBird loader 在 **QQ 进程内** dlopen `wrapper.node` + `NineBird.node`，
   `NineBird.node` 用 dyld 枚举 + Mach-O xref 扫描定位 `DidRecvResponseData`，funchook 内联 hook。
   全程无跨进程注入，SIP 管不着。

所以唯一必须 native 的部分是 hooker（已由 nt_helper 产出 `NineBird.darwin-{x64,arm64}.node`），
安装 / 启动器全部是 TS。

## 沙箱与文件布局

QQ（App Store 版）是沙箱应用，只能读写自己的容器
`~/Library/Containers/com.tencent.qq/Data/`。因此 NineBird 的一切运行时文件都部署在容器内：

```
~/Library/Containers/com.tencent.qq/Data/Documents/weq-ninebird/
  loadNineBird.js    # 入口 shim（package.json.main 指向它）
  NineBird.node      # hooker（从 native/darwin/<arch>/ninebird 拷入）
  qqnt.json          # 占位
  qr-dbkey.js        # loader 运行时（pnpm build:ninebird 产物）
  quick-dbkey.js
  account-list.js
  package.json       # {"type":"commonjs"} 标记
```

`/Applications/QQ.app/Contents/Resources/app/package.json` 的 `main` 被改成指向
`loadNineBird.js` 的**相对路径**（备份为 `package.json.bak`），热更新包
（容器 `versions/<v>/QQUpdate.app/…/package.json`）同步 patch / 还原。

## 提权：为什么不抄 pkexec，也不让 Electron 以 root 跑

macOS 没有 polkit / pkexec。但 Linux 提权注入的**架构**可以照搬：非特权主进程
只做数据准备，特权部分收敛成一个短命子进程。

这里照抄 napcat-mac-installer 的 `sudo -S`：渲染层弹密码框，密码经 stdin 喂给
`/usr/bin/sudo -S /bin/sh -c <sh>`，root 只执行两个字节级 `cp`：

- 备份：`[ -f package.json.bak ] || cp -p package.json package.json.bak`
- 覆盖：`cp <临时 patched JSON> package.json`

Patched JSON 由 WeQ 自己（非特权）写进临时文件，root 永远不碰内容生成逻辑。
密码不落盘、不进日志；sudo 是 WeQ 的直接子进程，TCC 责任归属 WeQ，
Sequoia+ 在「系统设置 → 隐私与安全性 → App 管理」中加入 WeQ 后即可写入
QQ.app（安装器已内置该提示文案）。其余所有操作（容器文件、热更新
package.json）都在用户权限内，无需提权。

### 踩坑记录：osascript 提权是一条死路

曾照抄 WeFlow 用 `osascript ... do shell script ... with administrator
privileges` 弹系统授权框，结果 `cp` 到 QQ.app 内始终 `Operation not permitted`
（-60007 那步能过，写入被拒），即使把 WeQ 加进「App 管理」也一样。

原因：macOS 15「App 管理」TCC 禁止跨应用修改其它 app 的 bundle，而授权服务
拉起的 root 进程责任归属不在 WeQ，WeQ 拿到授权也没用。WeFlow 能用 osascript
是因为它只 `chmod` / 运行自己的 helper，从不写别的 app 的 bundle；我们的场景
（改 `/Applications/QQ.app` 入口）恰好踩中它没踩过的雷。因此**不要**再切回
osascript / hardened runtime 方案，`sudo -S` + 密码框（napcat 同款）是验证过
的可行路线。

## 启动流程（QR / 快捷登录）

```text
WeQ (非特权)
  └─ launchQQ (TS, darwin/boot.ts)
       ├─ ensureInstalled()  幂等部署 + 入口校验（未安装抛错引导去设置）
       ├─ spawn QQ --no-sandbox
       │    env: NINEBIRD_PIPE_NAME / NINEBIRD_LOAD_PATH /
       │         NINEBIRD_LOADER_DIR / NINEBIRD_TIMEOUT_MS /
       │         NINEBIRD_APPID / NINEBIRD_QUA / NINEBIRD_LOG
       └─ QQ 进程内
            ├─ loadNineBird.js → require(NINEBIRD_LOAD_PATH)
            ├─ dlopen wrapper.node（真 wrapper 只能在 QQ 自己的 Electron 里加载）
            ├─ require NineBird.node → installRecvHook（dyld + funchook）
            └─ 登录 → 0xcde_2 → 经 unix socket（容器 tmp 内）回传 dbkey
```

macOS 是单实例 QQ，启动前先 `SIGKILL` 掉已有 QQ（等同 napcat 的 terminateQQ），
否则新进程会把窗口让给旧实例直接退场，loader 永远跑不到。

## Bootstrap 页取密钥（在线实例优先扫内存）

macOS 的「获取密钥」不再走注入型实例取 key（SIP 下注入本来就不可用），改为：

1. **在线** → 弹管理员密码框（`sudo -S`，ninebird 安装同款），提权执行
   `nt_helper.scanKeyFromDatabase(dbPath, pid)`（零注入内存扫描，读取进程内存
   需要解除 SIP / task_for_pid 放行）。命中即直接填入密钥。
2. 扫描失败 → 弹窗提示「该账号 QQ 在线，pid：xxx，扫描在线进程获取密钥需要
   解除 SIP」，可选**确认重启** / 取消。
3. 确认重启 → 先查 NineBird 安装状态：**已安装不重复安装**；未安装则弹安装
   密码框提权安装（`installNineBird`）。随后走 quick-login 拉起 QQ（启动前
   自动杀掉旧实例），loader 一并回传 dbkey + p_skey 等凭据，与 win/linux 的
   `KeyResult` 契约完全一致。

提权扫描的执行体是独立的 `macScanWorker.mjs`（electron-vite 单独入口），
父进程 `sudo -S` 拉起，密码经 stdin 传入，root 只做「读内存 + 验库」两件事。

## 代码位置

- `packages/native/src/darwin/install.ts` — 路径 / 状态 / `sudo -S` 提权 / 补丁 / 热更新 / 卸载
- `packages/native/src/darwin/boot.ts` — TS 版 `launchQQ`（部署 + spawn QQ）
- `packages/native/src/loader.ts` — darwin 不再 stub，改用 TS boot
- `packages/native/src/ninebird.ts` — darwin 的 pipe socket 放 QQ 容器 tmp
- `packages/ninebird/src/qq-info.ts` — darwin 版本配置 / 数据根指向容器
- `packages/service/src/bootstrap/win32_key.ts` — darwin 启动前杀 QQ
- `apps/desktop/src/main/ipc/routers/bootstrap.ts` — 安装状态 / 安装 / 卸载 tRPC
- `apps/desktop/src/main/mac_scan_elevation.ts` / `mac_scan_worker.ts` — 提权扫内存
- `apps/desktop/src/renderer/src/views/bootstrap/LoginPanel.tsx` — 获取密钥流程分支
- `apps/desktop/src/renderer/src/components/settings/GlobalSettingsSection.tsx` — 设置页卡片（已并入全局设置，非 darwin 不渲染）

## 已知边界

- QQ 的 hardened runtime / library validation 是否放行 ad-hoc 签名的 `NineBird.node`
  是唯一未在真机验证的变量；若 dyld 拒绝，先在安装时 `codesign -s -` 签名再测。
- WeQ 若以 Rosetta（x64）运行在 Apple Silicon 上，hooker 会选 x64 切片，
  与 arm64 版 QQ 不匹配（与 win/linux 按 process.arch 选产物的限制一致）。
