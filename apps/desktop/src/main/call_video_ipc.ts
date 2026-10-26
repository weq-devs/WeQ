/**
 * 通话视频帧的二进制 IPC 接收端（主进程）。
 *
 * 与 `shared/call_video_ipc.ts` 配对：渲染层用 `ipcRenderer.send` 把 I420 平面
 * 直接推过来（结构化克隆，不经 JSON），这里转交给当前通话的编码器。
 *
 * 为什么不用 tRPC：见 `shared/call_video_ipc.ts` 的说明 —— 一帧 345 KB 的
 * `Uint8Array` 经 superjson 会变成 1.2 MB 的十进制文本，单帧开销 30 ms，
 * 15 fps 下渲染层主线程被吃满，两端画面都卡。
 *
 * 只注册一次；没有进行中的通话时直接丢弃（视频帧不需要排队，过期的画面没有意义）。
 */

import { ipcMain } from 'electron';
import { getLogger } from '@weq/service';
import { CALL_VIDEO_FRAME_CHANNEL, type CallVideoFrame } from '../shared/call_video_ipc';
import { findCallManager } from './call_registry';

const logger = getLogger().child({ scope: 'call-video-ipc' });

/** 尺寸校验用：一帧 I420 的 Y 平面必须恰好 `w*h`。 */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

export function registerCallVideoIpc(): void {
  ipcMain.on(CALL_VIDEO_FRAME_CHANNEL, (_event, raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const frame = raw as Partial<CallVideoFrame>;
    const y = asBytes(frame.y);
    const u = asBytes(frame.u);
    const v = asBytes(frame.v);
    if (!y || !u || !v) return;

    const manager = findCallManager();
    if (!manager) return;
    // 主进程侧还会再校验一次尺寸（见 NativeVideoEncoder.pushFrame）。
    manager.pushVideoFrame(y, u, v);
  });
  logger.debug('通话视频帧 IPC 已注册');
}
