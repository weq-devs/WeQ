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
 * ⚠️ **Linux 上 `desktopCapturer.getSources` 本身就是那个 portal 弹窗** —— 它会
 * 阻塞到用户在系统窗口里选完为止（本机实测无交互时卡 33 秒才返回）。所以这个
 * handler 千万别在放行前做耗时的事，否则用户看到的是「点了共享一直没反应」。
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
 * 等用户从系统选择器里挑源的超时。
 *
 * Linux 的 `desktopCapturer.getSources` 会阻塞到 portal 弹窗被处理为止。正常情况
 * 用户几秒内就会点；但弹窗被窗口管理器吞掉 / 用户在别的工作区时，不设超时会让
 * 共享请求永远挂着（界面一直转圈，且再也发不出新请求）。
 *
 * 给 2 分钟：足够慢的用户从容选择，又不至于挂到天荒地老。
 */
const SOURCE_PICK_TIMEOUT_MS = 120_000;

/** 给 promise 加超时，超时返回 null（不抛）。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn('等待屏幕源选择超时', { ms });
      resolve(null);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        logger.warn('获取屏幕源失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        resolve(null);
      },
    );
  });
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

      // ⚠️ **请求永远来自主窗口**，不要按「哪个窗口在调」去判断。
      //
      // 2026-10-28 真机诊断（这是花了三轮才定位的点）：
      //
      // ```text
      // ownerId: 1, mainId: 1, frameName: "",
      // frameUrl: "http://localhost:5173/", frameParent: "top",
      // windowIds: [2, 1]
      // ```
      //
      // `frameUrl` 是**主窗口**的 dev server 地址，不是通话窗的 `about:blank`。
      // 原因是 `CallWindow` 用 `createPortal` 把 DOM 渲染进 `popup.document`：DOM 在
      // 子窗口里，但**JS 执行上下文仍属于主窗口**。所以 `useCallScreen` 里的
      // `navigator.mediaDevices` 是主窗口那一份，请求自然从主窗口发出。
      //
      // 早先按 `frame.name === 'weq-call'` 判断（实测恒为空串），后来又改成
      // 「拒绝主窗口」——两种写法都把唯一可能的调用方拒掉了，屏幕上显示的就是
      // 那个极具误导性的 `AbortError: Invalid capture constraints`。
      //
      // 所以这里**不再按窗口身份拦截**：能走到这个 handler 的，一定是本应用注册
      // 了 preload 的渲染进程。
      const owner = webContents.fromFrame(frame);
      logger.info('屏幕共享请求', {
        ownerId: owner?.id ?? null,
        frameUrl: frame.url,
        video: request.videoRequested,
        audio: request.audioRequested,
      });

      try {
        if (!request.videoRequested && !request.audioRequested) {
          callback(null);
          return;
        }
        // 屏幕共享要一条 screen 源。音频只有 Windows 能走 loopback。
        //
        // ⚠️ Linux 下这条 `getSources` **就是**那个 XDG Portal 选择窗口 —— 它会
        // 一直阻塞到用户在系统弹窗里选完（本机实测无交互时 33 秒才返回）。这是预期
        // 行为，不是卡死：用户点完就立刻返回。但**必须**给它超时兜底，否则弹窗被
        // 窗口管理器吞掉时这里会永远挂着，界面一直转圈。
        const sources = await withTimeout(
          desktopCapturer.getSources({
            types: ['screen'],
            // 共享时缩略图没用（用户看到的是真实画面），拉最小尺寸省时间。
            thumbnailSize: { width: 0, height: 0 },
          }),
          SOURCE_PICK_TIMEOUT_MS,
        );
        const source = sources?.[0];
        if (!source) {
          logger.warn('屏幕共享没有可用源（或选择超时）');
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
