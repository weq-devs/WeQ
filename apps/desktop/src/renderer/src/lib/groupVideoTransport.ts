import type { GroupVideoDelivery, GroupVideoFrame } from '../../../shared/call_video_ipc';
import {
  decodeGroupVideoDelivery,
  encodeGroupVideoUpload,
  GROUP_VIDEO_WEB_PATH,
  groupVideoAck,
} from '../../../shared/group_video_wire';
import { client } from '../trpc/client';
import { accountGatewayPath } from './accountGateway';

export function createGroupVideoTransport(id: string) {
  const bridge = window.weq?.callVideo;
  if (bridge?.pushGroupFrame && bridge.subscribeGroup)
    return {
      push: (frame: GroupVideoFrame) => bridge.pushGroupFrame(frame),
      subscribe: (onFrame: (frame: GroupVideoDelivery) => void) =>
        bridge.subscribeGroup(id, onFrame),
    };

  let connection: WebSocket | undefined;
  let pending: { resolve: () => void; reject: (error: Error) => void } | undefined;
  let awaitKeyframe = false;
  return {
    push(frame: GroupVideoFrame) {
      if (awaitKeyframe && !frame.keyframe) return Promise.resolve();
      awaitKeyframe = false;
      const ws = connection;
      if (!ws || ws.readyState !== WebSocket.OPEN) return client.groupCall.pushVideo.mutate(frame);
      if (pending) return Promise.reject(new Error('上一帧群视频尚未完成'));
      return new Promise<void>((resolve, reject) => {
        ws.send(encodeGroupVideoUpload(frame));
        pending = { resolve, reject };
      });
    },
    subscribe(onFrame: (frame: GroupVideoDelivery) => void) {
      let legacy: ReturnType<typeof client.groupCall.video.subscribe> | undefined;
      const fallback = () => {
        const resumed = new Set<number>();
        legacy = client.groupCall.video.subscribe(
          { id },
          {
            onData: (frame) => {
              if (frame.keyframe) resumed.add(frame.uin);
              if (resumed.has(frame.uin)) onFrame(frame);
            },
          },
        );
      };
      let ws: WebSocket;
      try {
        const url = new URL(accountGatewayPath(GROUP_VIDEO_WEB_PATH), location.href);
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('id', id);
        ws = new WebSocket(url);
      } catch {
        fallback();
        return () => legacy?.unsubscribe();
      }
      connection = ws;
      ws.binaryType = 'arraybuffer';
      ws.onclose = () => {
        if (connection !== ws) return;
        connection = undefined;
        if (pending) {
          // 该帧可能未到达。下一关键帧之前跳过增量帧，恢复预测链。
          pending.resolve();
          pending = undefined;
          awaitKeyframe = true;
        }
        fallback();
      };
      ws.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
        if (connection !== ws || !(data instanceof ArrayBuffer)) return;
        const bytes = new Uint8Array(data);
        if (bytes.length === 1) {
          const current = pending;
          pending = undefined;
          if (bytes[0] === 0) current?.resolve();
          else current?.reject(new Error('群视频暂时无法发送'));
          return;
        }
        const delivery = decodeGroupVideoDelivery(bytes);
        if (!delivery) return;
        try {
          onFrame(delivery.frame);
        } finally {
          if (ws.readyState === WebSocket.OPEN) ws.send(groupVideoAck(delivery.seq));
        }
      };
      return () => {
        if (connection === ws) {
          connection = undefined;
          pending?.resolve();
          pending = undefined;
        }
        ws.close();
        legacy?.unsubscribe();
      };
    },
  };
}

export type GroupVideoTransport = ReturnType<typeof createGroupVideoTransport>;
