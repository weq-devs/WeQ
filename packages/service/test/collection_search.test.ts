import type { AccountSession } from '@weq/account';
import type { CollectionItem } from '@weq/db';
import { describe, expect, it, vi } from 'vitest';
import { CollectionService } from '../src/account/collection';
import { searchCollectionItems } from '../src/account/collection_search';
import { UnifiedSearchService } from '../src/account/unified_search';
import { htmlPlainText } from '../src/common/html_text';

function item(cid: string, text: string, collectTime = 1): CollectionItem {
  return {
    cid,
    type: 1,
    kind: 'text',
    createTime: 1,
    modifyTime: 1,
    collectTime,
    author: { strId: '合成来源', groupName: '合成群' },
    summary: { textSummary: { text } },
  };
}

describe('收藏本地全局检索', () => {
  it('正文、类型摘要与来源都能命中，包含已缓存详情且不索引 HTML 属性和脚本', () => {
    const rich: CollectionItem = {
      ...item('rich', ''),
      kind: 'richMedia',
      summary: { richMediaSummary: { title: '图文标题' } },
      cachedContent: {
        recordTime: 1,
        richMediaContent: {
          rawData:
            '<p data-secret="属性暗号">正文 &amp; 实体<br>不完整段落<script>脚本暗号</script><p hidden>隐藏暗号</p><p>下一段',
        },
      },
    };
    expect(searchCollectionItems([rich], '正文 & 实体', 0, 10).items[0]).toMatchObject({
      category: 'collection',
      cid: 'rich',
    });
    for (const word of ['属性暗号', '脚本暗号', '隐藏暗号'])
      expect(searchCollectionItems([rich], word, 0, 10).total).toBe(0);
    expect(searchCollectionItems([item('source', '')], '合成群', 0, 10).total).toBe(1);
    expect(htmlPlainText('<p>第一段<p>第二段 &lt;结果&gt;')).toBe('第一段\n第二段 <结果>');
    const voice: CollectionItem = {
      ...item('voice', ''),
      kind: 'audio',
      summary: {},
      cachedContent: { recordTime: 1, audioContent: { data: '缓存语音转写' } },
    };
    expect(searchCollectionItems([voice], '语音转写', 0, 10).total).toBe(1);
    const gallery: CollectionItem = {
      ...item('gallery', ''),
      kind: 'gallery',
      summary: { gallerySummary: { picList: [{ name: '离线图片.jpg', note: '合成照片说明' }] } },
    };
    expect(searchCollectionItems([gallery], '照片说明', 0, 10).items[0]?.cid).toBe('gallery');
  });

  it('最新收藏在前，同时间按稳定身份排序，分页和完整命中总数独立', () => {
    const rows = [item('b', '正文命中', 2), item('a', '正文命中', 2), item('c', '正文命中', 1)];
    expect(searchCollectionItems(rows, '命中', 1, 1)).toMatchObject({
      total: 3,
      items: [{ cid: 'b' }],
    });
    expect(searchCollectionItems(rows, '   ', 0, 10)).toEqual({ items: [], total: 0 });
  });

  it('读取全部本地页并接入完整正文；搜索不触发网络凭据和请求', async () => {
    const rows = Array.from({ length: 201 }, (_, index) =>
      item(`cid-${index}`, index === 200 ? '最后一页命中' : '其它正文'),
    );
    const listAll = vi.fn(async (limit: number, offset: number) =>
      rows.slice(offset, offset + limit),
    );
    const session = {
      context: { uin: '10001' },
      collection: { listAll, cachedContentByCids: vi.fn(async () => new Map()) },
    } as unknown as AccountSession;
    const service = new CollectionService(
      {} as ConstructorParameters<typeof CollectionService>[0],
      session,
      () => {
        throw new Error('搜索不得请求在线 QQ');
      },
    );
    const network = vi.spyOn(service, 'listCollectionsFromNetwork');
    expect(await service.searchLocal('最后一页', 3, 0)).toMatchObject({
      total: 1,
      items: [{ cid: 'cid-200' }],
    });
    expect(listAll.mock.calls).toEqual([
      [200, 0],
      [200, 200],
    ]);
    expect(network).not.toHaveBeenCalled();
  });

  it('类别范围、预览条数与更多页真实调用本地源，不触发其它 QQ 扫描', async () => {
    const search = vi.fn(async (keyword: string, limit: number, offset: number) =>
      searchCollectionItems([item('a', '命中'), item('b', '命中')], keyword, offset, limit),
    );
    const service = new UnifiedSearchService({} as AccountSession, { searchCollections: search });
    expect((await service.slowSearch('命中', 1, ['collection'])).collections).toHaveLength(1);
    expect(await service.moreSearch('collection', '命中', 1, 1)).toMatchObject({
      total: 2,
      hasMore: false,
      items: [{ cid: 'b' }],
    });
    expect(search.mock.calls).toEqual([
      ['命中', 1, 0],
      ['命中', 1, 1],
    ]);
    await service.slowSearch('命中', 1, []);
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('单一来源失败不丢弃其它类别，失败类别不能伪装为零命中', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const service = new UnifiedSearchService({} as AccountSession, {
        searchCollections: async () => {
          throw new Error('合成不可用');
        },
        generatedSources: () => ({
          agentLab: {
            listPersonas: () => [],
            listGroups: () => [],
            listPersonaSessions: () => [],
            getPersonaSessionConversation: () => [],
            getConversation: () => [],
            listGroupSessions: () => [],
            getGroupSessionConversation: () => [],
            getGroupMessages: () => [],
          },
          assistant: {
            listSessions: () => [{ id: 's', title: '合成助手' }],
            getConversation: () => [{ id: 'message-kept', text: '正文', ts: 1 }],
          },
        }),
      });
      expect(await service.slowSearch('正文', 3, ['collection', 'assistantMessage'])).toMatchObject(
        {
          failedCategories: ['collection'],
          collections: [],
          assistantMessages: [{ messageId: 'message-kept' }],
        },
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});
