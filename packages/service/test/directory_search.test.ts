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
  const hidden = vi.fn(async () => []);
  const services = vi.fn(async () => []);
  const current = vi.fn(async () => []);
  const session = {
    guildDirectNodes: { listSessions: async () => [] },
    profileInfo: { searchContacts: cached, profilesByUids: profiles },
    recentContacts: { searchIdentities: recent, getByTargetUids: current },
    groupMembers: { searchMembers: members },
    deletedSessions: { listDeletedSessions: deleted },
    buddies: { listBuddies: buddies },
    hiddenSessions: { listHiddenSessions: hidden },
    serviceAssistantContacts: { listContacts: services },
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
    hidden,
    services,
    current,
    service: new UnifiedSearchService(session),
  };
}

// 保留真实方法类型，夹具可以只填写本条断言涉及的字段。
function resolveMock<T>(mock: { mockResolvedValue: (value: T) => unknown }, value: unknown) {
  mock.mockResolvedValue(value as T);
}

describe('联系人和群聊的对象搜索', () => {
  it('联系人定位按当前、隐藏与删除记录判定，重开和无当前记录的旧隐藏标记不会误归类', async () => {
    const f = fixture();
    const ids = [
      'u_regular',
      'u_hidden',
      'u_deleted',
      'u_reopened',
      'u_stale_hidden',
      'u_cached',
      'u_muted',
    ];
    resolveMock(
      f.cached,
      ids.map((uid, index) => ({
        uid,
        uin: String(10001 + index),
        nick: `报告${uid}`,
        remark: '',
        avatarUrl: null,
      })),
    );
    resolveMock(
      f.recent,
      ['u_regular', 'u_reopened', 'u_muted'].map((targetUid) => ({
        targetUid,
        targetUin: '',
        chatType: 1,
        name: `报告${targetUid}`,
        remark: '',
        groupNick: '',
      })),
    );
    resolveMock(
      f.hidden,
      ['u_hidden', 'u_stale_hidden'].map((targetUid) => ({
        targetUid,
        targetUin: '',
        chatType: 'KCHATTYPEC2C',
      })),
    );
    resolveMock(
      f.deleted,
      ['u_deleted', 'u_reopened'].map((targetUid) => ({ targetUid, chatType: 1 })),
    );
    resolveMock(f.current, [
      { targetUid: 'u_hidden', notifyLevel: 1 },
      { targetUid: 'u_reopened', notifyLevel: 1 },
    ]);
    const hits = await searchContacts(f.session, '报告');
    const views = Object.fromEntries(hits.map((hit) => [hit.uid, hit.conversationView]));
    expect(views).toEqual({
      u_regular: 'regular',
      u_hidden: 'hidden',
      u_deleted: 'deleted',
      u_reopened: 'regular',
      u_stale_hidden: undefined,
      u_cached: undefined,
      u_muted: 'regular',
    });
    expect(f.current).toHaveBeenCalledWith(
      expect.arrayContaining(['u_hidden', 'u_stale_hidden', 'u_deleted', 'u_reopened']),
    );
    expect((await f.service.quickSearch('报告', 20, ['contact'], 'all', ['qq'])).contacts).toEqual(
      hits,
    );
    expect((await f.service.moreSearch('contact', '报告', 0, 20, 'all', ['qq'])).items).toEqual(
      hits,
    );
  });

  it('群助手只认真实通知级别 2，隐藏/删除优先，免打扰及缺失字段不推断为助手', async () => {
    const f = fixture();
    const ids = Array.from({ length: 9 }, (_, index) => String(20001 + index));
    resolveMock(
      f.groupCached,
      ids.map((groupCode) => ({
        groupCode,
        name: `报告群${groupCode}`,
        remark: '',
        inDirectory: false,
      })),
    );
    const currentIds = ['20001', '20003', '20005', '20009'];
    resolveMock(
      f.recent,
      currentIds.map((targetUid) => ({
        targetUid,
        targetUin: '0',
        chatType: 2,
        name: `报告群${targetUid}`,
        remark: '',
        groupNick: '',
      })),
    );
    resolveMock(
      f.current,
      currentIds.map((targetUid) => ({
        targetUid,
        chatType: 2,
        notifyLevel: targetUid === '20009' ? 2 : 1,
      })),
    );
    resolveMock(
      f.hidden,
      ['20003', '20008'].map((targetUid) => ({
        targetUid,
        targetUin: '',
        chatType: 'KCHATTYPEGROUP',
      })),
    );
    resolveMock(
      f.deleted,
      ['20004', '20005'].map((targetUid) => ({ targetUid, chatType: 2 })),
    );
    resolveMock(f.directory, [
      { groupCode: '20001', notifyLevel: 4 },
      { groupCode: '20002', notifyLevel: 2 },
      { groupCode: '20003', notifyLevel: 2 },
      { groupCode: '20004', notifyLevel: 2 },
      { groupCode: '20005', notifyLevel: 1 },
      { groupCode: '20006' },
    ]);
    const hits = await searchGroups(f.session, '报告');
    expect(Object.fromEntries(hits.map((hit) => [hit.groupCode, hit.conversationView]))).toEqual({
      '20001': 'regular',
      '20002': 'groupAssistant',
      '20003': 'hidden',
      '20004': 'deleted',
      '20005': 'regular',
      '20006': 'regular',
      '20007': undefined,
      '20008': undefined,
      '20009': 'groupAssistant',
    });
    expect((await f.service.quickSearch('报告', 20, ['group'], 'all', ['qq'])).groups).toEqual(
      hits,
    );
    expect((await f.service.moreSearch('group', '报告', 0, 20, 'all', ['qq'])).items).toEqual(hits);
  });

  it('读取服务号独立联系人表和隐藏小表，不假设它们都在最近会话表', async () => {
    const f = fixture();
    resolveMock(f.services, [{ appId: 90001n, displayName: '报告服务号', avatarUrl: '' }]);
    resolveMock(f.hidden, [
      { targetUid: 'u_hidden', targetUin: '10001', chatType: 'KCHATTYPEC2C' },
      { targetUid: '20001', targetUin: '', chatType: 'KCHATTYPEGROUP' },
    ]);
    resolveMock(f.profiles, [
      { uid: 'u_hidden', uin: 10001n, nick: '报告隐藏联系人', remark: '', avatarUrl: '' },
    ]);
    resolveMock(f.details, [{ groupCode: 20001n, groupName: '报告隐藏群', remark: '' }]);
    const contacts = await searchContacts(f.session, '报告');
    expect(contacts).toMatchObject([
      { uid: '90001', nick: '报告服务号', chatType: 118, hasConversation: true },
      { uid: 'u_hidden', nick: '报告隐藏联系人', chatType: 1, hasConversation: true },
    ]);
    expect(await searchGroups(f.session, '报告')).toMatchObject([
      { groupCode: '20001', name: '报告隐藏群', hasConversation: true },
    ]);
    expect(f.recent).toHaveBeenCalledTimes(2);
  });
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
    expect(hits.map((hit) => hit.uid).sort()).toEqual(['device', 'u_cache', 'u_deleted', 'u_temp']);
    expect(hits.find((hit) => hit.uid === 'device')).toMatchObject({
      chatType: 8,
      temporary: false,
    });
    expect(hits.every((hit) => !hit.isFriend)).toBe(true);
    expect(hits.find((hit) => hit.uid === 'u_temp')?.temporary).toBe(true);
  });

  it('公众号和服务号归联系人类型，保留会话类型且不同于同号好友', async () => {
    const f = fixture();
    resolveMock(f.cached, [
      { uid: 'u_friend', uin: '10001', nick: '报告好友', remark: '', avatarUrl: null },
    ]);
    resolveMock(f.buddies, [{ uid: 'u_friend', uin: 10001n }]);
    resolveMock(f.recent, [
      {
        targetUid: 'official',
        targetUin: '10001',
        chatType: 103,
        name: '报告公众号',
        remark: '',
        groupNick: '',
      },
      {
        targetUid: 'service',
        targetUin: '10001',
        chatType: 118,
        name: '报告服务号',
        remark: '',
        groupNick: '',
      },
    ]);
    const hits = await searchContacts(f.session, '报告');
    expect(hits).toHaveLength(3);
    expect(hits.find((hit) => hit.uid === 'official')).toMatchObject({
      chatType: 103,
      hasConversation: true,
      isFriend: false,
    });
    expect(hits.find((hit) => hit.uid === 'service')).toMatchObject({
      chatType: 118,
      hasConversation: true,
      isFriend: false,
    });
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
