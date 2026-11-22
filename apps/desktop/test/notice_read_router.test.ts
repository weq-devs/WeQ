// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createNoticeReadSync } from '../src/main/ipc/routers/notice_read';
import type { NoticeReadSnapshot } from '../src/shared/notice_seen';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
describe('跨端通知已读', () => {
  it('订阅携带初始快照，跨端更新即时推送，其他来源不串入，重连补回', async () => {
    let state: NoticeReadSnapshot | null = null;
    const api = createNoticeReadSync(() => ({
      getNoticeSeen: () => state,
      setNoticeSeen: (_kind, incoming) => {
        state = incoming;
      },
    })).router.createCaller({});
    const received: (NoticeReadSnapshot | null)[] = [];
    const other: (NoticeReadSnapshot | null)[] = [];
    const sub = (await api.changed({ ...binding, kind: 'friend' })).subscribe({
      next: (next) => received.push(next),
    });
    const otherSub = (
      await api.changed({ ...binding, expectedAccountConfigId: 'other', kind: 'friend' })
    ).subscribe({ next: (next) => other.push(next) });
    expect(received).toEqual([null]);
    const incoming = { seen: ['buddy-request:u_a:200'], readThrough: 200 };
    await api.merge({ ...binding, kind: 'friend', state: incoming });
    expect(received).toEqual([null, incoming]);
    expect(other).toEqual([null]);
    sub.unsubscribe();
    otherSub.unsubscribe();
    const reconnected: (NoticeReadSnapshot | null)[] = [];
    const reconnect = (await api.changed({ ...binding, kind: 'friend' })).subscribe({
      next: (next) => reconnected.push(next),
    });
    expect(reconnected).toEqual([incoming]);
    reconnect.unsubscribe();
  });
  it('桌面已读可供 Web/Remote 读取，旧端写回不倒退，账号来源隔离', async () => {
    const records = new Map<string, Partial<Record<'friend' | 'group', NoticeReadSnapshot>>>();
    const { router } = createNoticeReadSync((input) => {
      const key = `${input.expectedAccountUin}:${input.expectedAccountConfigId}`;
      const record = records.get(key) ?? {};
      records.set(key, record);
      return {
        getNoticeSeen: (kind) => record[kind] ?? null,
        setNoticeSeen: (kind, state) => {
          record[kind] = state;
        },
      };
    });
    const desktop = router.createCaller({});
    const remote = router.createCaller({});
    for (const kind of ['friend', 'group'] as const) {
      const prefix = kind === 'friend' ? 'buddy-request:u_a' : 'group-notify:123:u_a';
      await desktop.merge({
        ...binding,
        kind,
        state: { seen: [`${prefix}:200`], readThrough: 200 },
      });
      await remote.merge({
        ...binding,
        kind,
        state: { seen: [`${prefix}:100`], readThrough: 100 },
      });
      expect(await remote.snapshot({ ...binding, kind })).toEqual({
        seen: [`${prefix}:100`, `${prefix}:200`],
        readThrough: 200,
      });
      expect(
        await remote.snapshot({ ...binding, expectedAccountConfigId: 'source-b', kind }),
      ).toBeNull();
    }
  });
  it('QQ 水位分箱推送，迟到和旧客户端回写不回退，重连从持久快照恢复', async () => {
    let group: NoticeReadSnapshot | null = null;
    const resolve = (account: typeof binding) => ({
      getNoticeSeen: (kind: 'friend' | 'group') =>
        account.expectedAccountConfigId === binding.expectedAccountConfigId && kind === 'group'
          ? group
          : null,
      setNoticeSeen: (_kind: 'friend' | 'group', state: NoticeReadSnapshot) => {
        group = state;
      },
    });
    const sync = createNoticeReadSync(resolve);
    const remote = sync.router.createCaller({});
    const input = { ...binding, kind: 'group' } as const;
    const received: (NoticeReadSnapshot | null)[] = [];
    const sub = (await remote.changed(input)).subscribe({ next: (state) => received.push(state) });
    sync.confirmGroupRead(binding, 'normal', '200');
    expect(received).toEqual([
      null,
      { seen: [], readThrough: 0, baselinePending: true, qqGroupRead: { normal: '200' } },
    ]);
    sync.confirmGroupRead(binding, 'normal', '199');
    expect(received).toHaveLength(2);
    await remote.merge({
      ...input,
      state: { seen: ['group-notify-seq:normal:210'], readThrough: 0 },
    });
    expect(received.at(-1)).toEqual({
      seen: ['group-notify-seq:normal:210'],
      readThrough: 0,
      qqGroupRead: { normal: '200' },
    });
    sub.unsubscribe();
    sync.confirmGroupRead(binding, 'filtered', '300');
    const restarted = createNoticeReadSync(resolve).router.createCaller({});
    const reconnect = (await restarted.changed(input)).subscribe({
      next: (state) => received.push(state),
    });
    expect(received.at(-1)?.qqGroupRead).toEqual({ normal: '200', filtered: '300' });
    expect(await restarted.snapshot({ ...input, kind: 'friend' })).toBeNull();
    expect(await restarted.snapshot({ ...input, expectedAccountConfigId: 'other' })).toBeNull();
    reconnect.unsubscribe();
  });
});
