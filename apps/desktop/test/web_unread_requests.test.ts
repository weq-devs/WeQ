import { createTRPCProxyClient } from '@trpc/client';
import superjson from 'superjson';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppRouter } from '../src/shared/router';
import {
  HTTP_BATCH_MAX_URL_LENGTH,
  unreadRequestBatches,
  type UnreadRequest,
} from '../src/renderer/src/lib/unreadRequests';
import { UNREAD_BATCH_SIZE } from '../src/renderer/src/lib/unreadRefresh';

vi.mock('@trpc/client', async (original) => ({
  ...(await original<typeof import('@trpc/client')>()),
  createWSClient: vi.fn(() => ({ close: vi.fn(), request: vi.fn() })),
}));
afterEach(() => vi.unstubAllGlobals());

const input = (count: number): UnreadRequest => ({
  expectedAccountUin: '10001',
  expectedAccountConfigId: 'fixture-config',
  targets: Array.from({ length: count }, (_, index) => ({
    chatType: index % 2 ? 1 : 2,
    uid: index % 2 ? `u_${String(index).padStart(22, 'x')}` : String(70000 + index),
  })),
});

it('当前真实 tRPC 拒绝原 256 会话输入，Web 分批后全部返回且实际 URL 不超限', async () => {
  const requests: UnreadRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (value: RequestInfo | URL) => {
      const url = new URL(String(value), 'http://localhost');
      expect(url.pathname.length + url.search.length).toBeLessThanOrEqual(
        HTTP_BATCH_MAX_URL_LENGTH,
      );
      const encoded = JSON.parse(url.searchParams.get('input')!) as Record<
        string,
        ReturnType<typeof superjson.serialize>
      >;
      const results = Object.values(encoded).map((value) => {
        const request = superjson.deserialize<UnreadRequest>(value);
        requests.push(request);
        return {
          result: {
            data: superjson.serialize(
              request.targets.map((target) => ({ ...target, unreadCount: 7 })),
            ),
          },
        };
      });
      return new Response(JSON.stringify(results));
    }),
  );
  const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
  const client = createTRPCProxyClient<AppRouter>({ transformer: superjson, links: createLinks() });
  const original = input(UNREAD_BATCH_SIZE);
  await expect(client.account.getUnreadInfos.query(original)).rejects.toThrow(
    'Input is too big for a single dispatch',
  );
  expect(requests).toHaveLength(0);
  const rows = (
    await Promise.all(
      unreadRequestBatches(original, true).map((batch) =>
        client.account.getUnreadInfos.query(batch),
      ),
    )
  ).flat();
  expect(rows.map(({ chatType, uid }) => ({ chatType, uid }))).toEqual(original.targets);
  expect(requests.flatMap((request) => request.targets)).toEqual(original.targets);
  expect(rows.every((row) => row.unreadCount === 7)).toBe(true);
});

it.each(['ordinary', 'encoded'] as const)(
  '五千会话及 %s 账号字段按实际编码长度分批，保留重复目标和读取选项',
  async (kind) => {
    const original = input(5000);
    original.watermarksOnly = true;
    if (kind === 'encoded') {
      original.expectedAccountConfigId = '合成数据源 / % & ? '.repeat(4);
      original.targets[1] = { chatType: 1, uid: '合成 / ? & % + 表情' };
    }
    original.targets.push(original.targets[0]!);
    const requests: UnreadRequest[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (value: RequestInfo | URL) => {
        const url = new URL(String(value), 'http://localhost');
        expect(url.pathname.length + url.search.length).toBeLessThanOrEqual(
          HTTP_BATCH_MAX_URL_LENGTH,
        );
        const encoded = JSON.parse(url.searchParams.get('input')!) as Record<
          string,
          ReturnType<typeof superjson.serialize>
        >;
        return new Response(
          JSON.stringify(
            Object.values(encoded).map((value) => {
              const request = superjson.deserialize<UnreadRequest>(value);
              requests.push(request);
              expect(request.expectedAccountConfigId).toBe(original.expectedAccountConfigId);
              expect(request.watermarksOnly).toBe(true);
              return { result: { data: superjson.serialize(request.targets) } };
            }),
          ),
        );
      }),
    );
    const { createLinks } = await import('../src/renderer/src/trpc/transport.web');
    const client = createTRPCProxyClient<AppRouter>({
      transformer: superjson,
      links: createLinks(),
    });
    const batches = unreadRequestBatches(original, true);
    const rows = (
      await Promise.all(batches.map((batch) => client.account.getUnreadInfos.query(batch)))
    ).flat();
    expect(rows).toEqual(original.targets);
    expect(requests.flatMap((request) => request.targets)).toEqual(original.targets);
    expect(batches.every((batch) => batch.targets.length <= UNREAD_BATCH_SIZE)).toBe(true);
  },
);

it('IPC 保留 256 项上限，空目录不发请求，单目标过长明确报错', () => {
  const original = input(UNREAD_BATCH_SIZE + 1);
  expect(unreadRequestBatches(original, false).map((batch) => batch.targets.length)).toEqual([
    UNREAD_BATCH_SIZE,
    1,
  ]);
  expect(unreadRequestBatches(input(0), true)).toEqual([]);
  expect(unreadRequestBatches(input(1), true)).toEqual([input(1)]);
  const oversized = { ...input(1), expectedAccountConfigId: 'x'.repeat(HTTP_BATCH_MAX_URL_LENGTH) };
  expect(() => unreadRequestBatches(oversized, true)).toThrow('单个会话参数超过传输长度上限');
  expect(unreadRequestBatches(oversized, false)).toEqual([oversized]);
});
