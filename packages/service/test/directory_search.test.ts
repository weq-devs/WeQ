import type { AccountSession } from '@weq/account';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedSearchService } from '../src/account/unified_search';
import { searchContacts, searchGroups } from '../src/account/directory_search';

function fixture() {
  const cached = vi.fn(async () => []);
  const recent = vi.fn(async () => []);
  const members = vi.fn(async () => ({ items: [], total: 0 }));
  const deleted = vi.fn(async () => []);
  const groupCached = vi.fn(async () => []);
  const profiles = vi.fn(async () => []);
  const details = vi.fn(async () => []);
  const buddies = vi.fn(async () => []);
  const directory = vi.fn(async () => []);
  const session = {
    profileInfo: { searchContacts: cached, profilesByUids: profiles },
    recentContacts: { searchIdentities: recent },
    groupMembers: { searchMembers: members },
    deletedSessions: { listDeletedSessions: deleted },
    buddies: { listBuddies: buddies },
    groupDetail: {
      searchIdentities: groupCached,
      detailsByGroupCodes: details,
      listDirectory: directory,
    },
    uidMap: { uinByUid: () => undefined },
  } as unknown as AccountSession;
  return {
    session,
    cached,
    recent,
    members,
    deleted,
    groupCached,
    profiles,
    details,
    buddies,
    directory,
    service: new UnifiedSearchService(session),
  };
}

// 保留真实方法类型，夹具可以只填写本条断言涉及的字段。
function resolveMock<T>(mock: { mockResolvedValue: (value: T) => unknown }, value: unknown) {
  mock.mockResolvedValue(value as T);
}

describe('联系人和群聊的对象搜索', () => {
  it('临时会话的群名片别名可以单独命中，旧 UID 同号时仍按当前好友身份打开', async () => {
    const f = fixture();
    resolveMock(f.recent, [
      {
        targetUid: 'u_old',
        targetUin: '10001',
        chatType: 100,
        name: '昵称',
        remark: '',
        groupNick: '报告名片',
      },
    ]);
    resolveMock(f.buddies, [{ uid: 'u_current', uin: 10001n }]);
    expect(await searchContacts(f.session, '报告')).toMatchObject([
      {
        uid: 'u_current',
        uin: '10001',
        isFriend: true,
        aliases: expect.arrayContaining(['报告名片']),
      },
    ]);
  });
  it('同一好友、私聊、多个群名片及旧 UID 按 QQ 号合为一个人，保留命中来源', async () => {
    const f = fixture();
    resolveMock(f.cached, [
      {
        uid: 'u_friend',
        uin: '10001',
        nick: '昵称',
        remark: '报告',
        avatarUrl: null,
        isFriend: true,
      },
      { uid: 'u_old', uin: '10001', nick: '旧报告', remark: '', avatarUrl: null, isFriend: false },
    ]);
    resolveMock(f.buddies, [{ uid: 'u_friend', uin: 10001n }]);
    resolveMock(f.profiles, [
      { uid: 'u_friend', uin: 10001n, nick: '昵称', remark: '报告', avatarUrl: '' },
    ]);
    resolveMock(f.recent, [
      {
        targetUid: 'u_friend',
        targetUin: '10001',
        chatType: 1,
        name: '报告',
        remark: '',
        groupNick: '',
      },
    ]);
    resolveMock(f.members, {
      items: [20001, 20002].map((code) => ({
        groupCode: String(code),
        uid: 'u_friend',
        uin: '10001',
        nick: '昵称',
        card: '报告名片',
      })),
      total: 2,
    });
    resolveMock(
      f.details,
      [20001, 20002].map((code) => ({
        groupCode: BigInt(code),
        groupName: `群${code}`,
        remark: '',
      })),
    );
    const hits = await searchContacts(f.session, '报告');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      uid: 'u_friend',
      isFriend: true,
      hasConversation: true,
      groups: [
        { groupCode: '20001', display: '报告名片' },
        { groupCode: '20002', display: '报告名片' },
      ],
    });
    expect(hits[0]?.aliases).toContain('旧报告');
  });

  it('临时会话、缓存非好友和删除会话可命中，不把历史会话或缓存标成已删除好友', async () => {
    const f = fixture();
    resolveMock(f.cached, [
      {
        uid: 'u_cache',
        uin: '10001',
        nick: '报告缓存',
        remark: '',
        avatarUrl: null,
        isFriend: false,
      },
    ]);
    resolveMock(f.recent, [
      {
        targetUid: 'u_temp',
        targetUin: '10002',
        chatType: 100,
        name: '报告临时',
        remark: '',
        groupNick: '',
      },
      {
        targetUid: 'device',
        targetUin: '10003',
        chatType: 8,
        name: '报告手机',
        remark: '',
        groupNick: '',
      },
    ]);
    resolveMock(f.deleted, [{ targetUid: 'u_deleted', chatType: 1 }]);
    resolveMock(f.profiles, [
      { uid: 'u_deleted', uin: 10004n, nick: '报告历史', remark: '', avatarUrl: '' },
    ]);
    const hits = await searchContacts(f.session, '报告');
    expect(hits.map((hit) => hit.uid).sort()).toEqual(['u_cache', 'u_deleted', 'u_temp']);
    expect(hits.every((hit) => !hit.isFriend)).toBe(true);
    expect(hits.find((hit) => hit.uid === 'u_temp')?.temporary).toBe(true);
  });

  it('同名不同人不合并，精确命中在去重后排序，更多分页无重复漏项', async () => {
    const f = fixture();
    resolveMock(
      f.cached,
      ['x报告', '报告', '报告后缀', '报告'].map((nick, i) => ({
        uid: `u_${i}`,
        uin: `${10001 + i}`,
        nick,
        remark: '',
        avatarUrl: null,
        isFriend: false,
      })),
    );
    const quick = await f.service.quickSearch('报告', 1, ['contact']);
    const first = await f.service.moreSearch('contact', '报告', 0, 2);
    const second = await f.service.moreSearch('contact', '报告', 2, 2);
    expect(quick.contacts?.[0]?.nick).toBe('报告');
    expect(first.total).toBe(4);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(
      new Set([...first.items, ...second.items].map((hit) => ('uid' in hit ? hit.uid : ''))),
    ).toHaveProperty('size', 4);
  });

  it('群聊合并通讯录、群资料和会话，包含已删除会话但不推断退群解散状态', async () => {
    const f = fixture();
    resolveMock(f.groupCached, [
      { groupCode: '20001', name: '报告群', remark: '', inDirectory: true },
      { groupCode: '20002', name: '报告历史群', remark: '', inDirectory: false },
    ]);
    resolveMock(f.directory, [{ groupCode: '20001' }]);
    resolveMock(f.recent, [
      { targetUid: '20001', chatType: 2, name: '报告群', remark: '' },
      { targetUid: 'u_temp', chatType: 100, name: '报告临时', remark: '' },
    ]);
    resolveMock(f.deleted, [{ targetUid: '20003', chatType: 2 }]);
    resolveMock(f.details, [{ groupCode: 20003n, groupName: '报告删除会话', remark: '' }]);
    const hits = await searchGroups(f.session, '报告');
    expect(hits).toHaveLength(3);
    expect(hits.find((hit) => hit.groupCode === '20001')).toMatchObject({
      inDirectory: true,
      hasConversation: true,
    });
    expect(hits.find((hit) => hit.groupCode === '20003')).toMatchObject({
      inDirectory: false,
      hasConversation: true,
    });
    expect(f.members).not.toHaveBeenCalled();
  });
});
