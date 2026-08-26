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

这里用的是 `osascript` 的 Authorization Services：

```text
do shell script "<sh>" with administrator privileges
```

由系统弹原生授权框，root 只执行两个字节级 `cp`：

- 备份：`[ -f package.json.bak ] || cp -p package.json package.json.bak`
- 覆盖：`cp <临时 patched JSON> package.json`

Patched JSON 由 WeQ 自己（非特权）写进临时文件，root 永远不碰内容生成逻辑。
其余所有操作（容器文件、热更新 package.json）都在用户权限内，无需提权。

> 注意：Sequoia+ 需要在「系统设置 → 隐私与安全性 → App 管理」中加入 WeQ，
> 否则 osascript 会报 `not permitted`（安装器已内置该提示文案）。

## 启动流程（QR / 快捷登录）

```text
WeQ (非特权)
  └─ launchQQ (TS, darwin/boot.ts)
       ├─ ensureInstalled()  幂等部署 + 入口补丁（首次弹授权框）
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

## 代码位置

- `packages/native/src/darwin/install.ts` — 路径 / 状态 / osascript 提权 / 补丁 / 热更新 / 卸载
- `packages/native/src/darwin/boot.ts` — TS 版 `launchQQ`（部署 + spawn QQ）
- `packages/native/src/loader.ts` — darwin 不再 stub，改用 TS boot
- `packages/native/src/ninebird.ts` — darwin 的 pipe socket 放 QQ 容器 tmp
- `packages/ninebird/src/qq-info.ts` — darwin 版本配置 / 数据根指向容器
- `packages/service/src/bootstrap/win32_key.ts` — darwin 启动前杀 QQ
- `apps/desktop/src/main/ipc/routers/bootstrap.ts` — 安装状态 / 安装 / 卸载 tRPC
- `apps/desktop/src/renderer/src/components/settings/NineBirdSection.tsx` — 设置页卡片

## 已知边界

- QQ 的 hardened runtime / library validation 是否放行 ad-hoc 签名的 `NineBird.node`
  是唯一未在真机验证的变量；若 dyld 拒绝，先在安装时 `codesign -s -` 签名再测。
- WeQ 若以 Rosetta（x64）运行在 Apple Silicon 上，hooker 会选 x64 切片，
  与 arm64 版 QQ 不匹配（与 win/linux 按 process.arch 选产物的限制一致）。
