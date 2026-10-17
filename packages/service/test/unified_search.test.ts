import type { AccountSession } from '@weq/account';
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
  const groupFiles = vi.fn(emptyPage);
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
