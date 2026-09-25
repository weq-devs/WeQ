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
import { MergeForwardDraftStore } from '../src/account/merge_forward_drafts';

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
