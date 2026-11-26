import { describe, expect, it, vi } from 'vitest';
import {
  resolveGroupSenderPage,
  resolveGroupSenders,
  type GroupPageSenderMember,
  type GroupPageSenderMessage,
} from '../src/account/export/sender_resolve';

const iterateGroup = vi.hoisted(() => vi.fn());
vi.mock('../src/account/export/message_source', () => ({
  iterateGroupMessages: iterateGroup,
  iterateC2cMessages: vi.fn(),
  iterateOfficialMessages: vi.fn(),
  iterateServiceMessages: vi.fn(),
}));
vi.mock('../src/account/export/forward_expand', () => ({
  exportForwardContents: (messages: unknown) => messages,
}));

const group = 123456n;
function row(uid: string, uin = 123n): GroupPageSenderMessage {
  return { targetGroupCode: group, senderUid: uid, senderUin: uin };
}
function member(
  uid: string,
  overrides: Partial<GroupPageSenderMember> = {},
): GroupPageSenderMember {
  return { groupCode: group, uid, uin: 456n, card: '', nick: 'cached', adminFlag: 0, ...overrides };
}

describe('resolveGroupSenderPage', () => {
  it('preserves order, handles arbitrary page sizes and deduplicates lookups', async () => {
    const getMembersByUids = vi.fn(async () => [member('a', { card: '群名片 password=示例' })]);
    const nicksByUids = vi.fn(async () => ({ b: 'global' }));
    const rows = Array.from({ length: 301 }, (_, i) => row(i % 2 ? 'b' : 'a'));
    const result = await resolveGroupSenderPage(group, rows, { getMembersByUids, nicksByUids });
    expect(result.status).toBe('ok');
    expect(result.senders).toHaveLength(301);
    expect(result.senders[0]).toMatchObject({
      senderUid: 'a',
      displayName: '群名片 password=示例',
      uin: '123',
    });
    expect(result.senders[1]).toMatchObject({ senderUid: 'b', displayName: 'global' });
    expect(getMembersByUids).toHaveBeenCalledTimes(1);
    expect(getMembersByUids).toHaveBeenCalledWith(group, ['a', 'b']);
    expect(nicksByUids).toHaveBeenCalledTimes(1);
    expect(nicksByUids).toHaveBeenCalledWith(['b']);
  });

  it('resolves UIN-only rows using the native member lookup and full profiles', async () => {
    const getMembersByUins = vi.fn(async () => [member('resolved', { uin: 456n })]);
    const profilesByUids = vi.fn(async () => [
      { uid: 'resolved', uin: 456n, nick: 'profile', remark: '备注' },
      { uid: 'only_uid', uin: 789n, nick: '新昵称' },
    ]);
    const result = await resolveGroupSenderPage(group, [row('', 456n), row('only_uid', 0n)], {
      getMembersByUids: async () => [],
      getMembersByUins,
      profilesByUids,
    });
    expect(result.status).toBe('ok');
    expect(result.senders).toMatchObject([
      { senderUid: '', displayName: '备注', uin: '456', accountName: 'profile' },
      { senderUid: 'only_uid', displayName: '新昵称', uin: '789' },
    ]);
    expect(getMembersByUins).toHaveBeenCalledWith(group, [456n]);
    expect(profilesByUids).toHaveBeenCalledTimes(1);
  });

  it('processes every sender beyond a single SQL binding batch', async () => {
    const rows = Array.from({ length: 1001 }, (_, i) => row(`u_${i}`, BigInt(i + 1)));
    const getMembersByUids = vi.fn(async (_group: bigint, uids: string[]) =>
      uids.map((uid) => member(uid, { card: `${uid}名片` })),
    );
    const result = await resolveGroupSenderPage(group, rows, { getMembersByUids });
    expect(result.status).toBe('ok');
    expect(result.senders).toHaveLength(rows.length);
    expect(result.senders.at(-1)?.displayName).toBe('u_1000名片');
    expect(getMembersByUids.mock.calls.flatMap(([, uids]) => uids)).toEqual(
      rows.map((r) => r.senderUid),
    );
  });

  it('keeps valid batches when a lookup batch fails and preserves its actual cause', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => row(`u_${i}`, BigInt(i + 1)));
    const cause = new Error('SQL batch failure');
    const getMembersByUids = vi.fn(async (_group: bigint, uids: string[]) => {
      if (uids.includes('u_0')) throw cause;
      return uids.map((uid) => member(uid, { card: 'available' }));
    });
    const result = await resolveGroupSenderPage(group, rows, { getMembersByUids });
    expect(result.status).toBe('partial');
    expect(result.senders).toHaveLength(501);
    expect(result.senders.at(-1)?.displayName).toBe('available');
    expect(result.diagnostics).toEqual([{ stage: 'group_members', cause }]);
  });

  it('ignores stale group cards and admin roles for departed members', async () => {
    const result = await resolveGroupSenderPage(group, [row('left')], {
      getMembersByUids: async () => [
        member('left', { card: 'old card', memberFlag: 1, adminFlag: 1 }),
      ],
      nicksByUids: async () => ({ left: 'current' }),
    });
    expect(result.senders[0]).toMatchObject({ displayName: 'current', uin: '123' });
    expect(result.senders[0]?.role).toBeUndefined();
    expect(result.senders[0]).toMatchObject({ groupNickname: 'old card', memberFlag: 1 });
  });

  it('preserves fallback identities and the original lookup error', async () => {
    const cause = new Error('member database unavailable');
    const result = await resolveGroupSenderPage(group, [row('a'), row('', 456n), row('b', 0n)], {
      getMembersByUids: async () => {
        throw cause;
      },
      nicksByUids: async () => ({ b: 'global' }),
    });
    expect(result.status).toBe('partial');
    expect(result.senders.map((s) => s.displayName)).toEqual(['123', '456', 'global']);
    expect(result.diagnostics).toEqual([{ stage: 'group_members', cause }]);
    expect(result.senders[1]?.role).toBeUndefined();
  });

  it('does not look up messages from another group or accept foreign member rows', async () => {
    const getMembersByUids = vi.fn(async () => [member('a', { groupCode: 999n })]);
    await expect(
      resolveGroupSenderPage(group, [{ ...row('a'), targetGroupCode: 999n }], {
        getMembersByUids,
      }),
    ).rejects.toThrow('group_scope_mismatch');
    expect(getMembersByUids).not.toHaveBeenCalled();
    await expect(resolveGroupSenderPage(group, [row('a')], { getMembersByUids })).rejects.toThrow(
      'group_scope_mismatch',
    );
  });

  it('preserves database cancellation instead of returning a partial success', async () => {
    const error = new DOMException('数据库读取已取消', 'AbortError');
    const nicksByUids = vi.fn(async () => ({}));
    await expect(
      resolveGroupSenderPage(group, [row('a')], {
        getMembersByUids: async () => {
          throw error;
        },
        nicksByUids,
      }),
    ).rejects.toBe(error);
    expect(nicksByUids).not.toHaveBeenCalled();
  });

  it('honors the optional account scope check before and after asynchronous reads', async () => {
    let permitted = true;
    const getMembersByUids = vi.fn(async () => {
      permitted = false;
      return [member('a')];
    });
    const nicksByUids = vi.fn(async () => ({}));
    const result = await resolveGroupSenderPage(group, [row('a')], {
      authorize: () => permitted,
      getMembersByUids,
      nicksByUids,
    });
    expect(result).toEqual({ status: 'unauthorized', senders: [] });
    expect(nicksByUids).not.toHaveBeenCalled();
  });

  it('uses QQ numbers on each original message and falls back to UID when necessary', async () => {
    const result = await resolveGroupSenderPage(
      group,
      [row('a', 111n), row('a', 222n), row('b', 0n)],
      {
        getMembersByUids: async () => [],
      },
    );
    expect(result.senders.map((s) => s.displayName)).toEqual(['111', '222', 'b']);
    expect(result.status).toBe('partial');
  });
});

it('retains the existing export identity and display-name contract', async () => {
  iterateGroup.mockImplementationOnce(async function* () {
    yield row('a', 123n);
    yield row('a', 123n);
  });
  const resolveGroupMembers = vi.fn(async () => [
    {
      uid: 'a',
      uin: '456',
      card: 'card',
      nick: 'nick',
      remark: 'remark',
      adminFlag: 1,
    },
  ]);
  const result = await resolveGroupSenders(
    {} as never,
    String(group),
    undefined,
    {
      resolveGroupMembers,
    },
    'a',
  );
  expect(result.get('a')).toEqual({
    uin: '456',
    sourceName: 'nick',
    displayName: 'card',
    platformId: '456',
    accountName: 'nick',
    groupNickname: 'card',
    role: 'owner',
  });
  expect(resolveGroupMembers).toHaveBeenCalledWith(String(group), ['a']);
});
