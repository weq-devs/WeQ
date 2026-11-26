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

import { accountIpc } from './window_account_runtime';
import { MessageChannelMain, type WebContents } from 'electron';
import { getLogger } from '@weq/service';
import {
  CALL_VIDEO_FRAME_CHANNEL,
  CALL_VIDEO_ENCODED_CHANNEL,
  CALL_VIDEO_ENCODED_MAX_BYTES,
  GROUP_VIDEO_PORT_CHANNEL,
  GROUP_VIDEO_PUSH_CHANNEL,
  GROUP_VIDEO_SUBSCRIBE_CHANNEL,
  GROUP_VIDEO_UPLOAD_MAX_BYTES,
  type CallVideoFrame,
  type GroupVideoFrame,
} from '../shared/call_video_ipc';
import { findCallManager } from './call_registry';
import { currentGroupCall } from './group_call';
import { GroupVideoDeliveryQueue } from './group_video_delivery';
import { runtimeMaintenance } from './runtime_maintenance';

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

export function registerCallVideoIpc(mainContents: () => WebContents | undefined): void {
  accountIpc.on(CALL_VIDEO_FRAME_CHANNEL, (_event, raw: unknown) => {
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
  const isMainFrame = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
    event.sender === mainContents() && event.senderFrame === event.sender.mainFrame;
  accountIpc.handle(CALL_VIDEO_ENCODED_CHANNEL, (event, raw: unknown) => {
    if (!isMainFrame(event) || !raw || typeof raw !== 'object') return false;
    const frame = raw as { data?: unknown; keyframe?: unknown; captureId?: unknown };
    const data = asBytes(frame.data);
    if (
      !data?.length ||
      data.length > CALL_VIDEO_ENCODED_MAX_BYTES ||
      typeof frame.keyframe !== 'boolean' ||
      typeof frame.captureId !== 'string'
    )
      return false;
    return findCallManager()?.pushEncodedVideoFrame(data, frame.keyframe, frame.captureId) ?? false;
  });
  accountIpc.handle(GROUP_VIDEO_PUSH_CHANNEL, async (event, raw: unknown) => {
    if (!isMainFrame(event) || !raw || typeof raw !== 'object') return;
    const { id, data, secondary, keyframe } = raw as Partial<GroupVideoFrame>;
    if (
      typeof id !== 'string' ||
      typeof keyframe !== 'boolean' ||
      !(data instanceof Uint8Array) ||
      !(secondary instanceof Uint8Array) ||
      !data.length ||
      !secondary.length ||
      data.length > GROUP_VIDEO_UPLOAD_MAX_BYTES ||
      secondary.length > GROUP_VIDEO_UPLOAD_MAX_BYTES
    )
      throw new Error('群视频帧无效');
    await runtimeMaintenance.operation(async () => {
      currentGroupCall(id)?.session?.pushVideoFrame(data, keyframe, secondary);
    }, 'groupCall.pushVideo');
  });

  let stopDelivery: (() => void) | undefined;
  accountIpc.on(GROUP_VIDEO_SUBSCRIBE_CHANNEL, (event, id: unknown, subscription: unknown) => {
    const frame = event.senderFrame;
    if (!frame || !isMainFrame(event) || typeof id !== 'string' || typeof subscription !== 'number')
      return;
    const session = currentGroupCall(id)?.session;
    if (!session) return;
    stopDelivery?.();
    const { port1, port2 } = new MessageChannelMain();
    const delivery = new GroupVideoDeliveryQueue();
    const unbindVideo = session.onVideo((data, info) => {
      const seq = delivery.offer(info.uin, info.keyframe, data.byteLength);
      if (seq !== undefined) port1.postMessage({ ...info, data, seq });
    });
    const unbindState = session.onUpdate(({ state }) => {
      if (state === 'ended' || state === 'failed') close();
    });
    function close() {
      if (stopDelivery !== close) return;
      stopDelivery = undefined;
      unbindVideo();
      unbindState();
      port1.close();
    }
    stopDelivery = close;
    port1.on('message', ({ data }) => {
      if (data === 'close') close();
      else if (typeof data === 'number') delivery.acknowledge(data);
    });
    port1.once('close', close);
    port1.start();
    try {
      frame.postMessage(GROUP_VIDEO_PORT_CHANNEL, subscription, [port2]);
    } catch (error) {
      close();
      port2.close();
      logger.debug('群视频接收窗口已关闭', { error: String(error) });
    }
  });
  logger.debug('通话视频帧 IPC 已注册');
}
