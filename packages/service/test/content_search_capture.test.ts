import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { ContentSearchStore } from '../src/account/content_search';
import {
  contentReadingRecords,
  installContentSearchCapture,
} from '../src/account/content_search_capture';

it('公告、精华、闪传与评论保持独立目标，未知身份不入库，缓存可重开', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-subcontent-search-'));
  try {
    const path = join(root, 'index.json');
    const store = new ContentSearchStore(path);
    store.remember(
      contentReadingRecords(
        'getGroupBulletins',
        [10002n],
        [{ fid: 'notice-a', textContent: '共同关键词', msgTime: 1000n }],
      ),
    );
    store.remember(
      contentReadingRecords('getEssencePageWithContent', ['10002'], {
        messages: [{ msgSeq: 20, content: [{ text: '共同关键词' }], senderTime: 1001 }],
      }),
    );
    store.remember(
      contentReadingRecords('listFiles', ['fileset', '', ''], {
        files: [{ fileId: 'file-a', name: '共同关键词.png' }, { name: '无身份' }],
      }),
    );
    store.remember(
      contentReadingRecords(
        'getQzoneInteractions',
        ['10003'],
        new Map([
          [
            'post-a',
            {
              comments: [
                {
                  id: 'reply-a',
                  parentCommentId: 'root',
                  replyId: 'server-reply',
                  nickname: '合成人物',
                  content: '共同关键词',
                  isReply: true,
                  time: 1002,
                },
              ],
            },
          ],
        ]),
      ),
    );
    store.flush();
    const reopened = new ContentSearchStore(path);
    expect(reopened.search('groupBulletin', '关键词', 20).items[0]?.target).toEqual({
      kind: 'groupBulletin',
      groupCode: '10002',
      bulletinId: 'notice-a',
    });
    expect(reopened.search('groupEssence', '关键词', 20).items[0]?.target).toEqual({
      kind: 'groupEssence',
      groupCode: '10002',
      msgSeq: '20',
    });
    expect(reopened.search('flashFile', '关键词', 20).items[0]?.target).toMatchObject({
      parentId: '',
      zipFileId: '',
      fileId: 'file-a',
    });
    expect(reopened.search('qzoneComment', '关键词', 20).items[0]?.target).toMatchObject({
      tid: 'post-a',
      commentId: 'reply-a',
      parentCommentId: 'root',
      replyId: 'server-reply',
    });
    store.close();
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('成功读取才观察；切来源后的迟到结果不写，卸载恢复原方法', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-search-observe-'));
  try {
    const store = new ContentSearchStore(join(root, 'index.json'));
    let active = true;
    let sequence = 0;
    const read = async (_group?: bigint) => [{ fid: `id-${++sequence}`, textContent: '已读到' }];
    const sources = { groupInfo: { getGroupBulletins: read } };
    const stop = installContentSearchCapture(sources, store, () => active);
    await sources.groupInfo.getGroupBulletins();
    // 空参数没有群身份，不伪造可跳转目标。
    expect(store.search('groupBulletin', '已读到', 20).total).toBe(0);
    await sources.groupInfo.getGroupBulletins(10002n);
    expect(store.search('groupBulletin', '已读到', 20).total).toBe(1);
    active = false;
    await sources.groupInfo.getGroupBulletins(10002n);
    expect(store.search('groupBulletin', '已读到', 20).total).toBe(1);
    stop();
    expect(sources.groupInfo.getGroupBulletins).toBe(read);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('公共空间评论保留真实 union 身份和父回复，不借用旧说说 tid', async () => {
  const feed = {
    cell_common: { union_id: { uf_key: 'real-public-key', domain_type: 3 } },
    ticket: 'not-indexed',
  };
  const comment = {
    id: 'comment-a',
    content: [{ type: 0, content: '公共关键词' }],
    replys: [{ id: 'reply-a', content: [{ type: 0, content: '回复关键词' }] }],
  };
  const records = contentReadingRecords('getQzonePublicComments', [feed], {
    cell_comment: { comments: [comment] },
  });
  expect(records).toHaveLength(2);
  expect(records[1]?.target).toEqual({
    kind: 'qzonePublicComment',
    feedKey: 'real-public-key',
    feed: { cell_common: feed.cell_common },
    commentId: 'reply-a',
    parentCommentId: 'comment-a',
  });
  expect(
    contentReadingRecords('getQzonePublicReplies', [feed, { id: 'comment-a' }], {
      replys: comment.replys,
    })[0]?.target,
  ).toEqual(records[1]?.target);
  expect(
    contentReadingRecords('getQzonePublicComments', [{ cell_common: { union_id: {} } }], {
      cell_comment: { comments: [comment] },
    }),
  ).toEqual([]);
});
