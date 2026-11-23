// @vitest-environment node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket as Socket } from 'ws';
import type { GroupCallListener, GroupCallVideoListener } from '@weq/service';
import { createGroupVideoWebUpgrade } from '../src/main/web/group_video';
import { createGroupVideoTransport } from '../src/renderer/src/lib/groupVideoTransport';
import { GROUP_VIDEO_WEB_PATH } from '../src/shared/group_video_wire';

const legacy = vi.hoisted(() => ({
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  push: vi.fn(async () => {}),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    groupCall: { video: { subscribe: legacy.subscribe }, pushVideo: { mutate: legacy.push } },
  },
}));

describe('Web 群视频', () => {
  it('用现有会话授权收发二进制，处理积压并在撤销后释放', async () => {
    let allowed = false;
    const revoked = new Set<() => void>();
    const videos = new Set<GroupCallVideoListener>();
    const states = new Set<GroupCallListener>();
    const pushVideoFrame = vi.fn();
    const session = {
      pushVideoFrame,
      onVideo: (callback: GroupCallVideoListener) => {
        videos.add(callback);
        return () => videos.delete(callback);
      },
      onUpdate: (callback: GroupCallListener) => {
        states.add(callback);
        return () => states.delete(callback);
      },
    };
    const upgrade = createGroupVideoWebUpgrade(
      {
        isAuthed: () => allowed,
        watchSession: (_req, callback) => {
          revoked.add(callback);
          return () => revoked.delete(callback);
        },
      },
      (id) => (id === 'active' ? session : undefined),
    );
    const server = createServer();
    server.on('upgrade', (req, socket, head) => {
      if (!upgrade.upgrade(req, socket, head)) socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('缺少测试端口');
    const authority = `127.0.0.1:${address.port}`;
    const wsUrl = `ws://${authority}${GROUP_VIDEO_WEB_PATH}`;
    const denied = async (id: string, origin?: string) => {
      const ws = new Socket(`${wsUrl}?id=${id}`, { origin });
      const [error] = await once(ws, 'error');
      return error.message as string;
    };
    let unsubscribe: (() => void) | undefined;
    try {
      expect(await denied('active')).toContain('401');
      allowed = true;
      expect(await denied('active', 'https://other.invalid')).toContain('401');
      expect(await denied('old')).toContain('404');
      vi.stubGlobal('window', {});
      vi.stubGlobal('location', new URL(`http://${authority}`));
      const sockets: WebSocket[] = [];
      vi.stubGlobal(
        'WebSocket',
        class extends WebSocket {
          constructor(url: URL) {
            super(url);
            sockets.push(this);
          }
        },
      );
      const transport = createGroupVideoTransport('active');
      const received = vi.fn();
      unsubscribe = transport.subscribe(received);
      await vi.waitFor(() => expect(sockets[0]?.readyState).toBe(WebSocket.OPEN));
      const data = new Uint8Array(80 * 1024).fill(13);
      const secondary = new Uint8Array(1024).fill(17);
      await transport.push({ id: 'active', data, secondary, keyframe: true });
      const [primary, keyframe, low] = pushVideoFrame.mock.calls[0]!;
      expect([primary.byteLength, primary[0], keyframe, low.byteLength, low[0]]).toEqual([
        81920,
        13,
        true,
        1024,
        17,
      ]);
      const send = (uin: number, keyframe: boolean) => {
        for (const listener of videos) listener(data, { uin, keyframe }, 0);
      };
      send(1, true);
      send(1, false);
      send(1, false);
      send(2, true);
      await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(3));
      send(1, false);
      send(1, true);
      await vi.waitFor(() => expect(received).toHaveBeenCalledTimes(4));
      expect(
        received.mock.calls.map(([frame]) => [frame.uin, frame.keyframe, frame.data[0]]),
      ).toEqual([
        [1, true, 13],
        [1, false, 13],
        [2, true, 13],
        [1, true, 13],
      ]);
      expect(legacy.subscribe).not.toHaveBeenCalled();
      expect(legacy.push).not.toHaveBeenCalled();
      allowed = false;
      for (const revoke of revoked) revoke();
      await vi.waitFor(() => {
        expect(videos.size + states.size + revoked.size).toBe(0);
        expect(legacy.subscribe).toHaveBeenCalledOnce();
      });
    } finally {
      unsubscribe?.();
      vi.unstubAllGlobals();
      upgrade.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
