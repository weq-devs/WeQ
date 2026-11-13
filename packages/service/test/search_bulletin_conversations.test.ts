import type { AccountSession } from '@weq/account';
import { expect, it, vi } from 'vitest';
import { UnifiedSearchService } from '../src/account/unified_search';
import type { ContentSearchHit } from '../src/account/content_search';

function fixture() {
  const bulletins: ContentSearchHit[] = ['123', '123', '123', '123', '456'].map(
    (groupCode, index) => ({
      category: 'groupBulletin',
      id: `bulletin-${index}`,
      target: { kind: 'groupBulletin', groupCode, bulletinId: String(index) },
      title: '关键词公告标题',
      content: '关键词公告正文',
      sourceName: `群 ${groupCode} · 公告`,
      time: 10 - index,
      observedAt: 10,
    }),
  );
  const details = vi.fn(async (codes: bigint[]) =>
    codes.map((groupCode) => ({
      groupCode,
      groupName: groupCode === 123n ? '项目讨论群' : '只有公告命中的群',
      remark: '',
    })),
  );
  const session = {
    buddyMsgFts: { topConversationsByKeyword: async () => [] },
    groupMsgFts: { topConversationsByKeyword: async () => [{ partition: 123n, count: 2 }] },
    groupDetail: { detailsByGroupCodes: details },
  } as unknown as AccountSession;
  const searchContent = vi.fn(
    (category: string, _keyword: string, limit: number, offset: number) => {
      const hits = category === 'groupBulletin' ? bulletins : [];
      return {
        items: hits.slice(offset, offset + limit),
        total: hits.length,
        coverage: {
          scope: 'observed-cache' as const,
          records: hits.length,
          limited: false,
          updatedAt: 10,
        },
      };
    },
  );
  return {
    service: new UnifiedSearchService(session, { searchContent }),
    bulletins,
    searchContent,
  };
}

it('公告按群合并到消息会话，单独命中的群也使用真实群名和会话身份', async () => {
  const f = fixture();
  const page = await f.service.moreSearch('chatRecord', '关键词', 0, 20, 'real', ['qq']);
  expect(page.total).toBe(2);
  expect(page.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: 'chatRecord',
        source: 'group',
        partition: '123',
        targetUid: '123',
        name: '项目讨论群',
        count: 2,
        matchedBulletins: 4,
      }),
      expect.objectContaining({
        category: 'chatRecord',
        source: 'group',
        partition: '456',
        targetUid: '456',
        name: '只有公告命中的群',
        count: 0,
        matchedBulletins: 1,
      }),
    ]),
  );
  expect(page.items.some((hit) => hit.category === 'groupBulletin')).toBe(false);
  const preview = await f.service.slowSearch('关键词', 3, ['chatRecord'], 'real', ['qq']);
  expect(preview.messageHits).toEqual(page.items);
});

it('多条同群公告先合并再分页，页尾没有重复会话或虚假的后续页', async () => {
  const f = fixture();
  const pages = await Promise.all(
    [0, 1, 2].map((offset) =>
      f.service.moreSearch('chatRecord', '关键词', offset, 1, 'real', ['qq']),
    ),
  );
  expect(pages.map((page) => page.total)).toEqual([2, 2, 2]);
  expect(pages.map((page) => page.hasMore)).toEqual([true, false, false]);
  expect(
    pages
      .flatMap((page) => page.items)
      .map((hit) => (hit.category === 'chatRecord' ? hit.targetUid : '')),
  ).toEqual(['123', '456']);
});

it('没有公告命中时不改变原消息数量，也不添加公告跳转标识', async () => {
  const f = fixture();
  await f.service.moreSearch('chatRecord', '关键词', 0, 20, 'real', ['qq']);
  f.bulletins.length = 0;
  const page = await f.service.moreSearch('chatRecord', '关键词', 0, 20, 'real', ['qq']);
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ category: 'chatRecord', count: 2 });
  expect(page.items[0]).not.toHaveProperty('matchedBulletins');
});
