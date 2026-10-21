# Linux 窗口后端：为什么 ozone-platform 必须走启动参数

2026-10-19。起因：Issue 反馈 Linux（Hyprland / Wayland 会话）下 `pnpm dev` 后主窗口不出现，
日志里 GPU 进程反复崩溃：

```
GPU process exited unexpectedly: exit_code=139
XGetWindowAttributes failed for window 1
```

## 结论

**`app.commandLine.appendSwitch('ozone-platform', 'x11')` 不生效，还会把窗口搞没。**
必须把 `--ozone-platform=x11` 放进 Electron 的**启动参数**。

- 开发：`electron.vite.config.ts` 注入 `ELECTRON_CLI_ARGS`（electron-vite 会在配置加载后、
  启动 Electron 前读取它，这是唯一能同时兼容 `pnpm dev -- --user-data-dir=…` 的注入点）。
- 打包：`electron-builder.yml` 的 `linux.executableArgs`，**但只写进 AppImage 的
  `.desktop`**，见下一节。
- 兜底：主进程在 `requestSingleInstanceLock` 之前调 `ozoneRelaunchArgs()`，参数不在
  argv 里就 `app.relaunch` 一次（`index.ts` 的 `relaunchForOzoneBackend`）。

`WEQ_OZONE_PLATFORM=wayland` 仍然可以退回原生 Wayland（纯 Wayland 桌面没有 DISPLAY 时
也会自动留在 Wayland）。

## 为什么打包版还要在运行时兜底重启（2026-10-22）

`linux.executableArgs` 在 electron-builder 25 里只有两个消费者：`AppImageTarget`
与 `LinuxTargetHelper.computeDesktopEntry`，**都只生成 `.desktop` 文件**。于是：

| 启动方式 | 参数在不在 |
| --- | --- |
| AppImage 从系统菜单 / 启动器打开 | 在（读 `.desktop` 的 `Exec`） |
| 直接执行 `./weQ-*.AppImage`、文件管理器双击 | 不在（`AppRun` 不读同目录的 `.desktop`） |
| tar.gz 解压后 `./weQ` | 不在（`ArchiveTarget` 只打包目录，不生成 desktop entry） |
| `pnpm dev` | 在（`ELECTRON_CLI_ARGS`） |

而且 `WEQ_OZONE_PLATFORM` 只在 `linux_window_backend.ts` 里被读取，那段代码在打包产物
里是死代码——发布版此前根本没有「退回原生 Wayland」的开关。

所以兜底放在主进程入口：argv 里没有 `--ozone-platform`、且判定结果需要一个后端时，
带参数 `app.relaunch()` 一次。三点约束：

1. **必须在 `app.requestSingleInstanceLock()` 之前**，否则新进程会撞上本进程持有的单实例锁。
2. `WEQ_OZONE_RELAUNCHED=1` 防死循环（重启后仍拿不到参数时不再套娃）。
3. AppImage 的 `process.execPath` 指向临时挂载点，父进程退出后会被卸载，重启要用
   `APPIMAGE` 环境变量指回真实文件，并补 `--no-sandbox`（FUSE 上 chrome-sandbox 的
   setuid 位无效）。

注意 `executableArgs` 一旦设置，electron-builder 给 AppImage 默认的 `--no-sandbox`
会被整个替换，所以 `electron-builder.yml` 里显式补了一行。

## 证据

1. 加诊断日志后，主进程里 `win.isVisible() === true`、`getBounds()` 正常、`ready-to-show`
   与 `did-finish-load` 都触发，渲染进程也连上了 Vite（`[vite] connected` + React 启动），
   但递归 `XQueryTree` 扫 X server 根窗口时根本没有对应的顶层窗口。
2. 最小复现（Electron 44.9.0 + Hyprland）：

   | 写法 | 结果 |
   | --- | --- |
   | `app.commandLine.appendSwitch('ozone-platform','x11')` | 无窗口，GPU 反复 SIGSEGV |
   | 命令行 `--ozone-platform=x11` | 正常，`xwayland=true`、`floating=true`，GPU 零崩溃 |
   | `appendSwitch('lang', …)` 等其它开关 | 正常（不是 `appendSwitch` 本身的问题） |
   | 原生 Wayland（无该开关） | 正常，但窗口被平铺 |

3. 另一个旁证：`appendSwitch` 的写法下，Electron 主进程命令行里能看到
   `--ozone-platform=x11`（说明 switch 被记录），GPU 进程也确实是 x11 平台，但 browser
   侧并没有按 X11 后端重建窗口 —— 两边对后端的认知不一致。

## 为什么不能靠 `whenReady` 更早

`ozone-platform` 决定 Chromium **进程级**的 Ozone 后端，在应用 JS 执行前就已选定。
`app.commandLine` 在 Electron 里有白名单，且即使记录成功也来不及切换已初始化的平台。

## 为什么仍然默认 XWayland

平铺合成器（Hyprland / sway）把 `type: 'toolbar'` 当普通平铺窗口，并且可能忽略程序化改
尺寸。走 XWayland 能保留浮动窗口与 1:1 逻辑像素。代价是 XWayland 本身的开销，以及
纯 Wayland 特性（如 per-surface 缩放）不可用。

## 回归测试

`apps/desktop/test/linux_window_backend.test.ts` 覆盖 `ozonePlatformArgs()` 的四种情形：
Wayland+X → `--ozone-platform=x11`；纯 X11 → 不加参数；显式 wayland → 不加参数；
非 Linux → 不加参数。另有 `ozoneRelaunchArgs()` 的用例：argv 已带开关（含 `.desktop`
的分开写法）不重启、AppImage 走 `execPath=APPIMAGE` 且补 `--no-sandbox`、
`WEQ_OZONE_RELAUNCHED=1` 不再重启。

## 以后再加 Linux 原生开关时

优先查该开关是否属于「进程初始化前」类别（Ozone、GPU、sandbox、locale）。这类开关一律
走启动参数，不要用 `appendSwitch`。
