import type { AccountSession } from '@weq/account';
import type { C2cMsg } from '@weq/db';
import { describe, expect, it, vi } from 'vitest';
import {
  SERVICE_SEARCH_CANDIDATE_LIMIT,
  UnifiedSearchService,
} from '../src/account/unified_search';

function message(id: number, title: string, content: string): C2cMsg {
  return {
    msgId: BigInt(id),
    msgSeq: BigInt(id),
    senderUid: 'service-sender',
    senderUin: 0n,
    sendTime: BigInt(id),
    elements: [
      {
        kind: 'ark',
        arkData: JSON.stringify({
          prompt: '通知摘要',
          meta: { detail_1: { title, desc: content } },
        }),
      },
    ],
  } as unknown as C2cMsg;
}
function fixture(rows: C2cMsg[]) {
  const listLatest = vi.fn(async () => rows);
  const contacts = vi.fn(async () => [{ appId: 90001n, displayName: '合成服务号' }]);
  const session = {
    buddyMsgFts: { topConversationsByKeyword: async () => [] },
    groupMsgFts: { topConversationsByKeyword: async () => [] },
    groupDetail: { detailsByGroupCodes: async () => [] },
    serviceAssistantContacts: { listContacts: contacts },
    serviceAssistantMsgs: { listLatest },
  } as unknown as AccountSession;
  return { service: new UnifiedSearchService(session), listLatest, contacts, session };
}
describe('服务号独立消息表搜索', () => {
  it('标题和正文不依赖普通私聊 FTS，预览、更多与具体记录保持相同身份', async () => {
    const f = fixture([
      message(3, '项目更新', '合成正文'),
      message(2, '合成标题', '其他内容'),
      message(1, '无关', '无关'),
    ]);
    const preview = await f.service.slowSearch('合成', 3, ['chatRecord'], 'virtual', ['qq']);
    expect(preview.messageHits).toMatchObject([
      {
        category: 'chatRecord',
        source: 'buddy',
        targetUid: 'service:90001',
        name: '合成服务号',
        count: 2,
      },
    ]);
    const more = await f.service.moreSearch('chatRecord', '合成', 0, 20, 'guild', ['qq']);
    expect(more.items).toEqual(preview.messageHits);
    const records = await f.service.conversationRecords('buddy', 'service:90001', '合成', 0, 1);
    expect(records).toMatchObject({
      total: 2,
      items: [{ msgId: '3', msgSeq: '3', content: expect.stringContaining('合成正文') }],
    });
    expect(
      (await f.service.conversationRecords('buddy', 'service:90001', '合成', 1, 1)).items[0]?.msgId,
    ).toBe('2');
    await f.service.slowSearch('标题', 3, ['chatRecord'], 'all', ['qq']);
    expect(f.listLatest).toHaveBeenCalledOnce();
    expect(f.listLatest).toHaveBeenCalledWith(
      { appId: 90001n },
      SERVICE_SEARCH_CANDIDATE_LIMIT + 1,
    );
  });
  it('候选读取有上限并明确标注，不把截断的计数当作完整历史', async () => {
    const f = fixture(
      Array.from({ length: SERVICE_SEARCH_CANDIDATE_LIMIT + 1 }, (_, index) =>
        message(index + 1, '合成标题', '正文'),
      ),
    );
    const more = await f.service.moreSearch('chatRecord', '合成', 0, 20, 'all', ['qq']);
    expect(more.limited).toBe(true);
    expect(more.items).toMatchObject([{ count: SERVICE_SEARCH_CANDIDATE_LIMIT }]);
    expect(await f.service.conversationRecords('buddy', 'service:90001', '合成')).toMatchObject({
      total: SERVICE_SEARCH_CANDIDATE_LIMIT,
      limited: true,
    });
  });
  it('未选 QQ 来源时不读服务号；失败不保留坏缓存，重试可恢复', async () => {
    const f = fixture([message(1, '合成', '正文')]);
    await f.service.slowSearch('合成', 3, ['chatRecord'], 'all', ['assistant']);
    expect(f.contacts).not.toHaveBeenCalled();
    f.session.groupMsgFts.topConversationsByKeyword = async () => [{ partition: 20001n, count: 1 }];
    f.listLatest.mockRejectedValueOnce(new Error('合成读取失败'));
    const failed = await f.service.slowSearch('合成', 3, ['chatRecord'], 'all', ['qq']);
    expect(failed.failedCategories).toContain('chatRecord');
    expect(failed.messageHits).toMatchObject([{ targetUid: '20001', count: 1 }]);
    expect(
      (await f.service.slowSearch('合成', 3, ['chatRecord'], 'all', ['qq'])).messageHits,
    ).toHaveLength(2);
  });
});
