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
 * ## ⚠️ `callback(null)` 会被报成「Invalid capture constraints」
 *
 * 2026-10-28 实测（Electron 44.9.1 / Hyprland）：
 *
 * ```
 * handler 放行 {"video": true}  → ✅ 960x540@15
 * handler 回 null               → ❌ AbortError: Invalid capture constraints
 * ```
 *
 * 这个错误名**极具误导性**：它跟分辨率 / 帧率约束完全无关，真正原因是主进程拒绝
 * 了这次请求。排查「共享屏幕报 Invalid capture constraints」时，先看这里有没有
 * 走到 `callback(null)`，不要去改渲染层的约束。
 *
 * ## 为什么不能按 frame 名认调用方
 *
 * 早先按 `request.frame?.name === 'weq-call'` 判断。**实测 `frame.name` 是空串**
 * —— 它取的是 iframe 的 name，不是 `window.open` 的窗口名。结果每次都走 deny 分支，
 * 屏幕共享永远失败，还报成上面那个看不懂的约束错误。
 *
 * 现在改成「除登记过的主窗口外一律放行」：主界面没有共享需求，缩小攻击面；工具窗
 * 的识别不依赖任何字符串匹配，窗口改名也不会静默坏掉。
 */

import { desktopCapturer, session, webContents, type Session } from 'electron';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'call-display-media' });

/**
 * 主窗口的 webContents id：来自主窗口的共享请求一律拒绝。
 *
 * 由 `main/index.ts` 在装 handler 时登记（那时主窗口还不一定建好，所以是可变的）。
 */
let mainWebContentsId: number | null = null;

/** 登记主窗口（`createMainWindow` 建好之后调用）。 */
export function setDisplayMediaMainWebContents(id: number | null): void {
  mainWebContentsId = id;
}

/** 当前主窗口 id（测试 / 诊断用）。 */
export function displayMediaMainWebContentsId(): number | null {
  return mainWebContentsId;
}

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
      const frame = request.frame;
      if (!frame) {
        logger.warn('屏幕共享请求没有 frame，拒绝');
        callback(null);
        return;
      }

      // ⚠️ 不要用 `frame.name`：实测它是空串（取的是 iframe name，不是窗口名），
      // 用它做判断会让每次共享都静默失败。改用 webContents 身份。
      const owner = webContents.fromFrame(frame);
      if (!owner || owner.id === mainWebContentsId) {
        logger.warn('屏幕共享请求来自不允许的窗口', {
          webContentsId: owner?.id ?? null,
          mainId: mainWebContentsId,
          frameName: frame.name,
        });
        callback(null);
        return;
      }

      try {
        if (!request.videoRequested && !request.audioRequested) {
          callback(null);
          return;
        }
        // 屏幕共享要一条 screen 源。音频只有 Windows 能走 loopback。
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
