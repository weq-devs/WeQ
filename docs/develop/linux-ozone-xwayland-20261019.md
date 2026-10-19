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
- 打包：`electron-builder.yml` 的 `linux.executableArgs`。

`WEQ_OZONE_PLATFORM=wayland` 仍然可以退回原生 Wayland（纯 Wayland 桌面没有 DISPLAY 时
也会自动留在 Wayland）。

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
非 Linux → 不加参数。

## 以后再加 Linux 原生开关时

优先查该开关是否属于「进程初始化前」类别（Ozone、GPU、sandbox、locale）。这类开关一律
走启动参数，不要用 `appendSwitch`。
