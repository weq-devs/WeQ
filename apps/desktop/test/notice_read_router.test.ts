// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createNoticeReadRouter } from '../src/main/ipc/routers/notice_read';
import { mergeNoticeSeen, type NoticeSeenState } from '../src/shared/notice_seen';

const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' };
describe('跨端通知已读', () => {
  it('订阅携带初始快照，跨端更新即时推送，其他来源不串入，重连补回', async () => {
    let state: NoticeSeenState | null = null;
    const api = createNoticeReadRouter(() => ({
      getNoticeSeen: () => state,
      mergeNoticeSeen: (_kind, incoming) => (state = mergeNoticeSeen(state, incoming)),
    })).createCaller({});
    const received: (NoticeSeenState | null)[] = [];
    const other: (NoticeSeenState | null)[] = [];
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
    const reconnected: (NoticeSeenState | null)[] = [];
    const reconnect = (await api.changed({ ...binding, kind: 'friend' })).subscribe({
      next: (next) => reconnected.push(next),
    });
    expect(reconnected).toEqual([incoming]);
    reconnect.unsubscribe();
  });
  it('桌面已读可供 Web/Remote 读取，旧端写回不倒退，账号来源隔离', async () => {
    const records = new Map<string, Partial<Record<'friend' | 'group', NoticeSeenState>>>();
    const router = createNoticeReadRouter((input) => {
      const key = `${input.expectedAccountUin}:${input.expectedAccountConfigId}`;
      const record = records.get(key) ?? {};
      records.set(key, record);
      return {
        getNoticeSeen: (kind) => record[kind] ?? null,
        mergeNoticeSeen: (kind, state) => (record[kind] = mergeNoticeSeen(record[kind], state)),
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
});
