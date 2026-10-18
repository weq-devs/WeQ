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
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  XDG_SESSION_TYPE?: string;
  WEQ_OZONE_PLATFORM?: string;
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
