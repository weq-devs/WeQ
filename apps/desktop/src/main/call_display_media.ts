/**
 * 通话窗口的 `getDisplayMedia` 放行。
 *
 * 两件事共用同一个 handler：
 *
 * 1. **屏幕共享**（所有平台）：渲染层要共享屏幕时必须走这条路 —— Electron 里
 *    `getDisplayMedia` 默认是拒绝的，必须由主进程显式应答。
 * 2. **Windows 的「电脑声音」**（loopback）：系统音频也只有这条路能拿到，
 *    录通话时用。音频固定回 `loopback`（Electron 44 起仅 Windows 支持）。
 *
 * ## 屏幕共享的源怎么选
 *
 * **Linux / macOS 15+ 交给系统选择器**，Windows 由这里自己挑：
 *
 * | 平台 | 做法 |
 * | --- | --- |
 * | Linux | `desktopCapturer.getSources` 在 Wayland/X11 下都会弹 XDG Portal 的
 * |       | 选择窗口（Hyprland / KDE / GNOME 各自风格），用户在那里选 |
 * | macOS 15+ | `useSystemPicker: true`，由 ScreenCaptureKit 的系统选择器处理 |
 * | macOS <15 / Windows | 这里用 `desktopCapturer` 拿主显示器 |
 *
 * 也就是说这个 handler 在 Linux 上只是「把 portal 已经选好的那个源交回去」，
 * 不会再有第二次弹窗。
 *
 * ## 为什么按窗口名认调用方
 *
 * 不校验 `securityOrigin`：dev 下渲染页是 `http://localhost:5173`，生产是
 * `file://`，两者都可能出现在同一套逻辑里；用 frame 名认更稳 —— 那个名字只有
 * `window.open(..., 'weq-call')` 能拿到。
 */

import { desktopCapturer, session, type Session } from 'electron';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'call-display-media' });

/** 通话窗口的 frame 名（见 `useToolWindow` 的 `name`）。 */
const CALL_WINDOW_NAME = 'weq-call';

/**
 * 给主会话装上 handler。
 *
 * 视频与音频的分支是独立的：
 *
 * - **只要视频**（屏幕共享）→ 交一个 screen 源；
 * - **只要音频**（Windows 录电脑声音）→ 仍然要给一条视频轨（Chromium 的约束
 *   要求两者至少有一个），渲染层拿到流之后立刻把视频轨停掉；
 * - **两者都要** → 一起给。
 */
export function installCallDisplayMediaHandler(target: Session = session.defaultSession): void {
  target.setDisplayMediaRequestHandler(
    async (request, callback) => {
      const frameName = request.frame?.name ?? '';
      if (frameName !== CALL_WINDOW_NAME) {
        callback(null);
        return;
      }

      try {
        // 屏幕共享要一条 screen 源。音频只有 Windows 能走 loopback。
        if (request.videoRequested || request.audioRequested) {
          const sources = await desktopCapturer.getSources({
            types: ['screen'],
            // 共享时缩略图没用（用户看到的是真实画面），拉最小尺寸省时间。
            thumbnailSize: { width: 0, height: 0 },
          });
          const source = sources[0];
          if (!source) {
            logger.warn('屏幕共享没有可用源');
            callback(null);
            return;
          }
          const loopbackSupported = process.platform === 'win32';
          callback(
            request.audioRequested && loopbackSupported
              ? { video: source, audio: 'loopback' }
              : { video: source },
          );
          return;
        }
        callback(null);
      } catch (error) {
        logger.warn('屏幕共享放行失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        callback(null);
      }
    },
    // macOS 15+ 用系统原生选择器（ScreenCaptureKit）。其它平台这个选项无效，
    // 仍然走上面的 handler。
    { useSystemPicker: process.platform === 'darwin' },
  );
}
