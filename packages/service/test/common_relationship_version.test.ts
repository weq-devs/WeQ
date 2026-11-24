import { beforeEach, expect, it, vi } from 'vitest';
import type { PacketNative } from '@weqbot/protocol';
import type { ContactMetricsService } from '../src/account/contact_metrics';

const attributes = vi.hoisted(() => vi.fn(async () => ({ friendCount: 2, groups: [] })));
vi.mock('@weqbot/protocol', async (original) => ({
  ...(await original<typeof import('@weqbot/protocol')>()),
  getCommonFriendCount: vi.fn(async () => 1),
  getCommonAttributes: attributes,
}));
import { AccountWriteService } from '../src/account/account_write';
beforeEach(() => attributes.mockClear());

it.each([false, true])('共同关系等待异步版本快照后才发请求，metrics=%s', async (metrics) => {
  let release!: (version: string) => void;
  const version = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const nt = {} as PacketNative;
  const service = new AccountWriteService(
    nt,
    {
      uin: '10001',
      selfUid: 'u_self',
      getBuddy: async () => null,
      listCategories: async () => [],
      clientVersion: version,
    },
    () => 42,
  );
  if (metrics)
    service.contactMetrics = {
      query: (_key: string, _fields: string[], load: () => Promise<unknown>) => load(),
    } as unknown as ContactMetricsService;
  const pending = service.commonRelationships('u_peer');
  expect(attributes).not.toHaveBeenCalled();
  release('7.0.2-200');
  expect(await pending).toMatchObject({
    friendCount: 1,
    attributeFriendCount: 2,
    groups: [],
    friendError: null,
    groupError: null,
  });
  expect(attributes).toHaveBeenCalledWith(nt, 42, '10001', 'u_peer', '7.0.2-200');
  expect(version).toHaveBeenCalledOnce();
});

it('等待版本期间切换进程，不向旧会话发送迟到的共同群请求', async () => {
  let pid = 42,
    release!: (version: string) => void;
  const service = new AccountWriteService(
    {} as PacketNative,
    {
      uin: '10001',
      selfUid: 'u_self',
      getBuddy: async () => null,
      listCategories: async () => [],
      clientVersion: () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    },
    () => pid,
  );
  const pending = service.commonRelationships('u_peer');
  pid = 43;
  release('7.0.2-200');
  await expect(pending).rejects.toThrow();
  expect(attributes).not.toHaveBeenCalled();
});
