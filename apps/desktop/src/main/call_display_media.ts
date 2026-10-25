/**
 * Windows 的「电脑声音」采集放行。
 *
 * 系统音频（loopback）只有 Chromium 的 `getDisplayMedia` 这条路能拿到，而且
 * Electron 里**必须**由主进程的 `setDisplayMediaRequestHandler` 显式应答 —— 默认
 * 行为是拒绝。所以这里注册一个只服务于通话窗口的 handler：
 *
 *   - 只有 `weq-call` 这个窗口发起的请求才放行（按 frame 的 URL/名称认）；
 *   - 音频固定回 `loopback`（Electron 44 起仅 Windows 支持）；
 *   - 视频仍然要给一条，Chromium 的约束要求两者至少有一个；渲染层拿到流之后
 *     立刻把视频轨停掉，只留音频。
 *
 * Linux 不走这条路（主进程直接 `parec` 采监视源），macOS 没有这个能力。所以
 * 这个模块在非 Windows 上是空操作。
 */

import { desktopCapturer, session, type Session } from 'electron';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'call-system-audio' });

/** 通话窗口的 frame 名（见 `useToolWindow` 的 `name`）。 */
const CALL_WINDOW_NAME = 'weq-call';

/**
 * 给主会话装上 handler。
 *
 * 注意这里**不**校验 `securityOrigin`：dev 下渲染页是 `http://localhost:5173`，
 * 生产是 `file://`，两者都可能出现在同一套逻辑里；用窗口名来认更稳（那个名字
 * 只有 `window.open(..., 'weq-call')` 能拿到）。
 */
export function installCallDisplayMediaHandler(target: Session = session.defaultSession): void {
  if (process.platform !== 'win32') return;
  target.setDisplayMediaRequestHandler(async (request, callback) => {
    const frameName = request.frame?.name ?? '';
    const isCallWindow = frameName === CALL_WINDOW_NAME;
    if (!isCallWindow || !request.audioRequested) {
      callback(null);
      return;
    }
    try {
      // 只要一条 screen 源，Chromium 才肯把 audio 一起给我们。
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const source = sources[0];
      if (!source) {
        callback(null);
        return;
      }
      callback({ video: source, audio: 'loopback' });
    } catch (error) {
      logger.warn('系统声音放行失败', {
        error: error instanceof Error ? error.message : String(error),
      });
      callback(null);
    }
  });
}
