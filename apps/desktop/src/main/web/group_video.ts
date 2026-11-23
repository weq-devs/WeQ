import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { GroupCallSession } from '@weq/service';
import { WebSocket, WebSocketServer } from 'ws';
import {
  decodeGroupVideoUpload,
  encodeGroupVideoDelivery,
  GROUP_VIDEO_WEB_MAX_INBOUND,
  GROUP_VIDEO_WEB_PATH,
  readGroupVideoAck,
} from '../../shared/group_video_wire';
import { GroupVideoDeliveryQueue } from '../group_video_delivery';
import { runtimeMaintenance } from '../runtime_maintenance';
import type { AuthGate } from './auth';

type VideoSession = Pick<GroupCallSession, 'onVideo' | 'onUpdate' | 'pushVideoFrame'>;
export type ResolveGroupVideo = (id: string) => VideoSession | undefined;

export function createGroupVideoWebUpgrade(
  auth: Pick<AuthGate, 'isAuthed' | 'watchSession'>,
  resolveSession: ResolveGroupVideo,
) {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: GROUP_VIDEO_WEB_MAX_INBOUND,
    perMessageDeflate: false,
  });
  return {
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const [path, query] = (req.url ?? '').split('?', 2);
      if (path !== GROUP_VIDEO_WEB_PATH) return false;
      const reject = (status: string) =>
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      const host = req.headers.host;
      const origin = req.headers.origin;
      if (
        !host ||
        (origin && origin !== `http://${host}` && origin !== `https://${host}`) ||
        !auth.isAuthed(req)
      ) {
        reject('401 Unauthorized');
        return true;
      }
      const id = new URLSearchParams(query).get('id') ?? '';
      const session = resolveSession(id);
      if (!session) {
        reject('404 Not Found');
        return true;
      }
      if (sockets.clients.size >= 16) {
        reject('503 Service Unavailable');
        return true;
      }
      sockets.handleUpgrade(req, socket, head, (ws) => {
        const queue = new GroupVideoDeliveryQueue();
        const terminate = () => ws.terminate();
        ws.on('error', terminate);
        const unwatch = auth.watchSession(req, terminate);
        let nextAuthCheck = Date.now() + 5000;
        let pushing = false;
        const unbindVideo = session.onVideo((data, info) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const seq = queue.offer(info.uin, info.keyframe, data.byteLength);
          if (seq !== undefined) ws.send(encodeGroupVideoDelivery(seq, { ...info, data }));
        });
        const unbindState = session.onUpdate(({ state }) => {
          if (state === 'ended' || state === 'failed') terminate();
        });
        ws.once('close', () => {
          unwatch();
          unbindVideo();
          unbindState();
        });
        ws.on('message', (data, binary) => {
          if (!binary || !Buffer.isBuffer(data)) {
            terminate();
            return;
          }
          const now = Date.now();
          if (now >= nextAuthCheck) {
            if (!auth.isAuthed(req) || resolveSession(id) !== session) {
              terminate();
              return;
            }
            nextAuthCheck = now + 5000;
          }
          const seq = readGroupVideoAck(data);
          if (seq !== undefined) {
            queue.acknowledge(seq);
            return;
          }
          const frame = decodeGroupVideoUpload(data);
          if (!frame || pushing) {
            terminate();
            return;
          }
          pushing = true;
          void runtimeMaintenance
            .operation(async () => {
              if (resolveSession(id) === session)
                session.pushVideoFrame(frame.data, frame.keyframe, frame.secondary);
            }, 'groupCall.pushVideo')
            .then(
              () => {
                pushing = false;
                if (ws.readyState === WebSocket.OPEN) ws.send(Uint8Array.of(0));
              },
              () => {
                pushing = false;
                if (ws.readyState === WebSocket.OPEN) ws.send(Uint8Array.of(1));
              },
            );
        });
      });
      return true;
    },
    close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
    },
  };
}
