import type { AccountSession } from '@weq/account';
import type { BuddyMsgFtsHit } from '@weq/db';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedSearchService, type SearchCategory } from '../src/account/unified_search';

function fixture() {
  const emptyPage = () => Promise.resolve({ items: [], total: 0 });
  const recent = vi.fn(emptyPage);
  const friends = vi.fn(emptyPage);
  const members = vi.fn(emptyPage);
  const buddyRecords = vi.fn(async () => []);
  const groupRecords = vi.fn(async (): Promise<Array<{ partition: bigint; count: number }>> => []);
  const buddyFiles = vi.fn(emptyPage);
  const groupFiles = vi.fn(
    async (): Promise<{ items: BuddyMsgFtsHit[]; total: number }> => ({ items: [], total: 0 }),
  );
  const session = {
    recentContacts: { searchByName: recent },
    profileInfo: { searchFriends: friends },
    groupMembers: { searchMembers: members },
    groupDetail: { detailsByGroupCodes: async () => [] },
    buddyMsgFts: {
      topConversationsByKeyword: buddyRecords,
      searchFilesByKeyword: buddyFiles,
    },
    groupMsgFts: {
      topConversationsByKeyword: groupRecords,
      searchFilesByKeyword: groupFiles,
    },
  } as unknown as AccountSession;
  return {
    session,
    service: new UnifiedSearchService(session),
    recent,
    friends,
    members,
    buddyRecords,
    groupRecords,
    buddyFiles,
    groupFiles,
  };
}

describe('全局搜索范围', () => {
  it('文件精确名称优先于较新的包含命中，同档仍按时间排序', async () => {
    const f = fixture();
    f.groupFiles.mockResolvedValue({
      items: [
        {
          msgId: 1n,
          msgSeq: 1n,
          targetUid: '10001',
          senderUid: '',
          chatType: 2,
          fileName: 'x报告',
          content: '',
          sendTime: 100n,
        },
        {
          msgId: 2n,
          msgSeq: 2n,
          targetUid: '10001',
          senderUid: '',
          chatType: 2,
          fileName: '报告',
          content: '',
          sendTime: 1n,
        },
      ],
      total: 2,
    });
    const result = await f.service.moreSearch('file', '报告', 0, 10);
    expect(result.items.map((hit) => ('msgId' in hit ? hit.msgId : ''))).toEqual(['2', '1']);
  });
  it('默认不扫描公共商城和生成对话，显式选择仍可检索', async () => {
    const searchContent = vi.fn(
      async (_category: string, _keyword: string, _limit: number, _offset: number) => ({
        items: [],
        total: 0,
        coverage: {
          scope: 'observed-cache' as const,
          records: 0,
          limited: false,
          updatedAt: null,
        },
      }),
    );
    const generatedSources = vi.fn();
    const f = fixture();
    const service = new UnifiedSearchService(f.session, {
      searchContent,
      generatedSources,
    });
    await service.slowSearch('needle');
    expect(searchContent.mock.calls.some(([category]) => category === 'marketEmoji')).toBe(false);
    expect(generatedSources).not.toHaveBeenCalled();
    await service.slowSearch('needle', 3, ['marketEmoji', 'cloneMessage']);
    expect(searchContent).toHaveBeenLastCalledWith('marketEmoji', 'needle', 3, 0);
    expect(generatedSources).toHaveBeenCalledOnce();
  });
  it('同名文件保留不同会话和不同消息，重复索引行只出现一次并按时间排序', async () => {
    const f = fixture();
    const hit = (id: bigint, targetUid: string, sendTime: bigint): BuddyMsgFtsHit => ({
      msgId: id,
      msgSeq: id,
      targetUid,
      senderUid: 'u_fixture',
      chatType: 2,
      fileName: '同名报告.pdf',
      content: '',
      sendTime,
    });
    f.groupFiles.mockResolvedValue({
      items: [
        hit(1n, '10001', 10n),
        hit(2n, '10002', 30n),
        hit(3n, '10001', 20n),
        hit(2n, '10002', 30n),
      ],
      total: 4,
    });
    const result = await f.service.moreSearch('file', '报告', 0, 20);
    expect(result.total).toBe(3);
    expect(result.items.map((item) => ('msgSeq' in item ? item.msgSeq : ''))).toEqual([
      '2',
      '3',
      '1',
    ]);
  });
  it('文件候选池未覆盖全部命中时显式标记，不将有限候选数冒称完整总数', async () => {
    const f = fixture();
    f.groupFiles.mockResolvedValue({ items: [], total: 500 });
    expect(await f.service.moreSearch('file', '报告', 0, 20)).toMatchObject({ limited: true });
  });
  it('未传范围兼容默认全选，快速类别继续并行查询', async () => {
    const f = fixture();
    await f.service.quickSearch('合成内容', 5);
    for (const query of [f.recent, f.friends, f.members]) {
      expect(query).toHaveBeenCalledWith('合成内容', 5, 0);
    }
  });

  it('只查勾选的快速类别，空范围不等于全部', async () => {
    const f = fixture();
    const scope: SearchCategory[] = ['friend'];
    await f.service.quickSearch('合成内容', 3, scope);
    expect(f.friends).toHaveBeenCalledOnce();
    expect(f.recent).not.toHaveBeenCalled();
    expect(f.members).not.toHaveBeenCalled();
    f.friends.mockClear();
    expect(await f.service.quickSearch('合成内容', 3, [])).toEqual({
      conversations: [],
      friends: [],
      groupMembers: [],
    });
    expect(f.friends).not.toHaveBeenCalled();
  });

  it('慢查询只执行选定数据源，相同关键词切换范围不复用错误缓存', async () => {
    const f = fixture();
    await f.service.slowSearch('合成内容', 3, ['file']);
    expect(f.buddyFiles).toHaveBeenCalledOnce();
    expect(f.groupFiles).toHaveBeenCalledOnce();
    expect(f.buddyRecords).not.toHaveBeenCalled();
    expect(f.groupRecords).not.toHaveBeenCalled();
    await f.service.slowSearch('合成内容', 3, ['chatRecord']);
    expect(f.buddyRecords).toHaveBeenCalledOnce();
    expect(f.groupRecords).toHaveBeenCalledOnce();
    expect(f.buddyFiles).toHaveBeenCalledOnce();
    expect(f.groupFiles).toHaveBeenCalledOnce();
  });

  it('未选中慢类别不触发扫描或索引初始化', async () => {
    const f = fixture();
    const indexes = vi.spyOn(f.service, 'ensureIndexes');
    await f.service.slowSearch('合成内容', 3, ['friend']);
    await f.service.slowSearch('合成内容', 3, []);
    expect(indexes).not.toHaveBeenCalled();
    for (const query of [f.buddyRecords, f.groupRecords, f.buddyFiles, f.groupFiles]) {
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('慢查询遵守调用方 limit，不把之前三条预览缓存当成完整结果', async () => {
    const f = fixture();
    f.groupRecords.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({ partition: BigInt(i + 1), count: 8 - i })),
    );
    const first = await f.service.slowSearch('合成内容', 1, ['chatRecord']);
    const next = await f.service.slowSearch('合成内容', 5, ['chatRecord']);
    expect(first.chatRecords).toHaveLength(1);
    expect(next.chatRecords).toHaveLength(5);
    expect(f.groupRecords).toHaveBeenCalledOnce();
  });
});
