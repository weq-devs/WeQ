/**
 * MergeForwardDraftStore 的离线单测（tmp 目录，不碰真实缓存）。
 *
 * 这个 store 是「合成聊天记录」的落盘底座。本轮把它从「渲染元素 elements」改成
 * 「分段 segs」——所以重点钉两件事：
 *   1. 新的 segs 正常存取、保序、保留发送者 / 装扮 / 来源 msgId；
 *   2. **旧草稿**（只有 elements、没有 segs）读回来不会丢，会被归一成 segs。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MergeForwardDraftStore,
  normalizeMergeForwardDraft,
} from '../src/account/merge_forward_drafts';

const tmpRoots: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-mf-draft-'));
  tmpRoots.push(dir);
  return join(dir, 'draft.json');
}
afterEach(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  tmpRoots.length = 0;
});

const sender = { uid: 'u_self', uin: '10001', name: '我' };

describe('MergeForwardDraftStore', () => {
  it('旧字符串素材归一成真正的文本分段，不生成只有 textContent 的半结构', () => {
    const draft = normalizeMergeForwardDraft(
      { nodes: [{ sender, time: 1, segs: ['旧版素材'] }] },
      'legacy',
    );
    expect(draft?.nodes[0]?.segs[0]).toMatchObject({ t: 'text', text: '旧版素材' });
  });
  it('严格写入失败不回报成功，也不改变内存草稿', () => {
    const file = tmpFile();
    writeFileSync(file, 'not-a-directory');
    const store = new MergeForwardDraftStore(join(file, 'drafts.json'), { strict: true });
    expect(() => store.save({ id: 'blocked', nodes: [] })).toThrow();
    expect(store.list()).toEqual([]);
  });
  it('重启读回仍保留嵌套来源，不能因保存丢失循环检测信息', () => {
    const path = tmpFile();
    new MergeForwardDraftStore(path, { strict: true }).save({
      id: 'record-a',
      nodes: [
        {
          id: 'nested',
          sender,
          time: 1,
          sourceCompositionId: 'record-b',
          segs: [
            {
              t: 'node',
              id: 'inner',
              userUin: sender.uin,
              nickname: sender.name,
              time: 1,
              sourceCompositionId: 'record-c',
              segs: [{ t: 'text', id: 'text', text: '正文' }],
            },
          ],
        },
      ],
    });
    expect(new MergeForwardDraftStore(path).get('record-a')?.nodes[0]).toMatchObject({
      sourceCompositionId: 'record-b',
      segs: [{ sourceCompositionId: 'record-c' }],
    });
  });
  it('保存 → 读回：segs 保序、装扮 / 来源 msgId 保留', () => {
    const store = new MergeForwardDraftStore(tmpFile());
    const saved = store.save({
      id: 'draft-1',
      title: '',
      nodes: [
        {
          id: 'n1',
          sender,
          segs: [
            { t: 'text', id: 's1', text: '你好' },
            { t: 'image', id: 's2', path: '/tmp/a.png', fileName: 'a.png' },
          ],
          time: 100,
          decoration: { bubbleId: 1, fontId: 2, widgetId: 3 },
          sourceMsgId: 'msg-1',
        },
      ],
    });

    expect(saved.nodes).toHaveLength(1);
    expect(saved.nodes[0]?.segs).toEqual([
      { t: 'text', id: 's1', text: '你好' },
      { t: 'image', id: 's2', path: '/tmp/a.png', fileName: 'a.png' },
    ]);
    expect(saved.nodes[0]?.decoration).toEqual({ bubbleId: 1, fontId: 2, widgetId: 3 });
    expect(saved.nodes[0]?.sourceMsgId).toBe('msg-1');

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('draft-1');
  });

  it('装扮的原始字体槽位（fontId1Raw / fontId2Raw）落盘后不丢', () => {
    // 40801 的 41525 / 41531 与元素 tag 56 / tag 15 恒等，转发要靠这两个原值透传。
    // 旧版 normalizeDecoration 只重建 {bubbleId,fontId,widgetId}，会把它们剪掉。
    const path = tmpFile();
    const store = new MergeForwardDraftStore(path);
    store.save({
      id: 'draft-raw',
      nodes: [
        {
          id: 'n1',
          sender,
          segs: [{ t: 'text', id: 's1', text: '你好' }],
          time: 1,
          // 真机一行：41531 = 116182（bit 16 标志位 + low16 交换过的 54981）。
          decoration: {
            bubbleId: 2116371,
            fontId: 54981,
            widgetId: 104228,
            fontId1Raw: 20671,
            fontId2Raw: 116182,
          },
        },
      ],
    });

    // 重新从磁盘读一遍（不靠内存里的对象）。
    const reloaded = new MergeForwardDraftStore(path).get('draft-raw');
    expect(reloaded?.nodes[0]?.decoration).toEqual({
      bubbleId: 2116371,
      fontId: 54981,
      widgetId: 104228,
      fontId1Raw: 20671,
      fontId2Raw: 116182,
    });
  });

  it('旧草稿（只有 elements）→ 归一成 segs，不丢', () => {
    const path = tmpFile();
    writeFileSync(
      path,
      JSON.stringify({
        'draft-legacy': {
          id: 'draft-legacy',
          title: '旧记录',
          createdAt: 1,
          updatedAt: 2,
          nodes: [
            {
              id: 'old-1',
              sender,
              elements: [{ type: 'text', data: { textContent: '老消息' } }],
              time: 5,
            },
          ],
        },
      }),
    );

    const store = new MergeForwardDraftStore(path);
    const draft = store.get('draft-legacy');
    expect(draft?.title).toBe('旧记录');
    expect(draft?.nodes[0]?.segs).toEqual([{ type: 'text', data: { textContent: '老消息' } }]);
  });

  it('remove 删除后 list 里不再有它', () => {
    const store = new MergeForwardDraftStore(tmpFile());
    store.save({ id: 'a', nodes: [] });
    store.save({ id: 'b', nodes: [] });
    expect(
      store
        .list()
        .map((d) => d.id)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(store.remove('a')).toBe(true);
    expect(store.list().map((d) => d.id)).toEqual(['b']);
  });

  it('save 覆盖同 id 保留 createdAt、刷新 updatedAt', () => {
    const store = new MergeForwardDraftStore(tmpFile());
    const first = store.save({ id: 'x', nodes: [], createdAt: 111 });
    const second = store.save({ id: 'x', nodes: [], title: '改过' });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
    expect(second.title).toBe('改过');
  });
});
