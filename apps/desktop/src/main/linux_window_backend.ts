/**
 * Electron 38+ defaults to native Wayland when a Wayland session is available.
 * On tiling compositors that changes two window semantics WeQ relied on:
 *
 * - `type: 'toolbar'` no longer requests a floating X11 window.
 * - Wayland compositors may ignore programmatic window sizes.
 *
 * Keep using Electron 44 while running it through XWayland, which preserves the
 * previous toolbar/floating behaviour and the renderer's 1:1 logical pixel
 * sizing. A native Wayland session without an X display stays on Wayland, and
 * `WEQ_OZONE_PLATFORM=wayland` provides an explicit opt-out.
 */
export type OzonePlatform = 'x11' | 'wayland';

type WindowBackendEnv = {
  APPIMAGE?: string;
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  XDG_SESSION_TYPE?: string;
  WEQ_OZONE_PLATFORM?: string;
  WEQ_OZONE_RELAUNCHED?: string;
  WEQ_WINDOW_TYPE?: string;
};

export function resolveOzonePlatform(
  platform: NodeJS.Platform = process.platform,
  env: WindowBackendEnv = {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WEQ_OZONE_PLATFORM: process.env.WEQ_OZONE_PLATFORM,
  },
): OzonePlatform | null {
  if (platform !== 'linux') return null;

  const override = env.WEQ_OZONE_PLATFORM?.trim().toLowerCase();
  if (override === 'wayland') return null;
  if (override === 'x11') return env.DISPLAY ? 'x11' : null;

  const isWayland =
    env.XDG_SESSION_TYPE?.toLowerCase() === 'wayland' || Boolean(env.WAYLAND_DISPLAY);
  return isWayland && env.DISPLAY ? 'x11' : null;
}

/**
 * 平铺 Wayland 合成器（Hyprland/sway）默认把新顶层窗平铺，需要靠非 `normal` 的窗口类型
 * 让 WM 当浮动窗处理。`toolbar` 是侵入性最小的一种（与 `splash` 不同，它保留任务栏入口）。
 * `WEQ_WINDOW_TYPE=normal` 或其它值可覆盖/关闭。
 */
export function floatingWindowType(
  platform: NodeJS.Platform = process.platform,
  env: { WEQ_WINDOW_TYPE?: string } = { WEQ_WINDOW_TYPE: process.env.WEQ_WINDOW_TYPE },
): string | undefined {
  const type = env.WEQ_WINDOW_TYPE ?? (platform === 'linux' ? 'toolbar' : undefined);
  return type && type !== 'normal' ? type : undefined;
}

/** 可直接展开进 `BrowserWindowConstructorOptions` 的窗口类型字段。 */
export function floatingWindowTypeOption(
  platform: NodeJS.Platform = process.platform,
  env: { WEQ_WINDOW_TYPE?: string } = { WEQ_WINDOW_TYPE: process.env.WEQ_WINDOW_TYPE },
): { type?: string } {
  const type = floatingWindowType(platform, env);
  return type ? { type } : {};
}

/**
 * Electron 启动参数里的 ozone 开关（不需要切换时返回空数组）。
 *
 * **必须走启动参数，不能 `app.commandLine.appendSwitch`**：Chromium 的 Ozone 平台在
 * 应用 JS 跑起来之前就已初始化，ready 之前 append 也来不及。Electron 44 + Hyprland
 * 实测：append 之后 `isVisible()` 为 true，但 X server 里没有顶层窗口，GPU 进程还会
 * 反复 SIGSEGV(exit_code=139)。同一个开关放到命令行上则一切正常。
 */
export function ozonePlatformArgs(
  platform: NodeJS.Platform = process.platform,
  env: WindowBackendEnv = {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WEQ_OZONE_PLATFORM: process.env.WEQ_OZONE_PLATFORM,
  },
): string[] {
  const ozone = resolveOzonePlatform(platform, env);
  return ozone ? [`--ozone-platform=${ozone}`] : [];
}

export type OzoneRelaunch = {
  execPath?: string;
  args: string[];
};

/**
 * 打包产物里 ozone 开关**经常根本不在启动参数里**：electron-builder 只会把它写进
 * AppImage 的 `.desktop`（`linux.executableArgs`），而 tar.gz 解压直跑、AppImage
 * 直接执行、文件管理器双击都不经过 `.desktop`。这些路径下 Electron 已经按原生
 * Wayland 初始化完了，JS 层做什么都太晚 —— 只能带着参数重启一次。
 *
 * **必须在 `app.requestSingleInstanceLock()` 之前调用**：此时本进程还没申请单实例
 * 锁，重启出来的新进程不会和它抢锁而自退出。
 *
 * 已经在 argv 里（dev 由 electron.vite.config.ts 注入，菜单启动由 `.desktop` 带）
 * 就不重启；`WEQ_OZONE_RELAUNCHED=1` 是防死循环的保险，避免重启后仍然拿不到参数
 * 时无限套娃。
 */
export function ozoneRelaunchArgs(
  argv: readonly string[] = process.argv,
  platform: NodeJS.Platform = process.platform,
  env: WindowBackendEnv = {
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    WEQ_OZONE_PLATFORM: process.env.WEQ_OZONE_PLATFORM,
    WEQ_OZONE_RELAUNCHED: process.env.WEQ_OZONE_RELAUNCHED,
  },
): OzoneRelaunch | null {
  if (platform !== 'linux') return null;
  if (env.WEQ_OZONE_RELAUNCHED === '1') return null;
  const hasFlag = argv.some(
    (arg) => arg === '--ozone-platform' || arg.startsWith('--ozone-platform='),
  );
  if (hasFlag) return null;

  const ozoneArgs = ozonePlatformArgs(platform, env);
  if (ozoneArgs.length === 0) return null;

  // AppImage：process.execPath 指向临时挂载点（父进程退出后会被卸载），
  // 重启必须指回真实的 .AppImage 文件。AppRun 会设置 APPIMAGE 环境变量。
  //
  // AppImage 挂在 nosuid 的 FUSE 上，chrome-sandbox 的 setuid 位无效 —— 直接执行
  // 时也得跟 `.desktop` 一样带 `--no-sandbox`，否则禁用了 unprivileged userns 的
  // 发行版会启动失败。tar.gz 解压在普通文件系统上，setuid 位有效，不用带。
  const appImage = env.APPIMAGE?.trim();
  const tail = appImage ? [...ozoneArgs, '--no-sandbox'] : ozoneArgs;
  if (appImage) return { execPath: appImage, args: [...argv.slice(1), ...tail] };

  // tar.gz / 其它：execPath 保持当前二进制，把原有参数留在前面（Electron 的
  // relaunch 默认就是 argv.slice(1)，这里显式拼上 ozone 开关）。
  return { args: [...argv.slice(1), ...tail] };
}
