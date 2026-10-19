import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MergeForwardArchiveStore } from '../src/account/merge_forward_archive';

const roots: string[] = [];
const sender = { uid: 'u_fixture', uin: '10001', name: '合成身份' };
function root() {
  const path = mkdtempSync(join(tmpdir(), 'weq-mf-archive-'));
  roots.push(path);
  return path;
}
afterEach(() => {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
  roots.length = 0;
});

describe('合成素材与历史归档', () => {
  it('历史只追加且与后续草稿编辑隔离，重启后保持来源与装扮', async () => {
    const path = root();
    const store = new MergeForwardArchiveStore(path);
    const input = {
      id: 'draft-fixture',
      title: '初版',
      nodes: [
        {
          id: 'n1',
          sender,
          time: 1,
          sourceMsgId: 'msg-fixture',
          decoration: { bubbleId: 1, fontId: 2, widgetId: 3, fontId2Raw: 116182 },
          segs: [{ t: 'text', id: 'seg1', text: '原内容' }],
        },
      ],
    };
    const first = await store.append('history', input);
    input.nodes[0]!.segs[0]!.text = '已修改';
    const second = await store.append('history', input);
    expect(second.id).not.toBe(first.id);
    const reopened = new MergeForwardArchiveStore(path);
    expect(reopened.list('history')).toHaveLength(2);
    expect(reopened.get('history', first.id)?.nodes[0]?.segs[0]).toMatchObject({ text: '原内容' });
    expect(reopened.get('history', first.id)?.sourceDraftId).toBe(input.id);
    expect(reopened.get('history', first.id)?.nodes[0]?.decoration?.fontId2Raw).toBe(116182);
    expect(reopened.list('material')).toEqual([]);
  });

  it('嵌套素材的媒体与封面流式归档去重，清除源缓存仍可使用', async () => {
    const path = root();
    const source = join(path, 'original.png');
    writeFileSync(source, Buffer.from('synthetic-image-bytes'));
    const store = new MergeForwardArchiveStore(join(path, 'archive'));
    const input = {
      id: 'draft-media',
      nodes: [
        {
          id: 'n1',
          sender,
          time: 1,
          segs: [{ t: 'node', segs: [{ t: 'video', path: source, thumbPath: source }] }],
        },
      ],
    };
    const saved = await store.append('material', input);
    const repeated = await store.append('material', input);
    rmSync(source);
    const segment = (saved.nodes[0]!.segs[0] as { segs: { path: string; thumbPath: string }[] })
      .segs[0]!;
    expect(segment.path).toBe(segment.thumbPath);
    expect(segment.path).not.toBe(source);
    expect(readFileSync(segment.path).toString()).toBe('synthetic-image-bytes');
    expect(readdirSync(join(path, 'archive', 'media'))).toHaveLength(1);
    expect(repeated.nodes).toEqual(saved.nodes);
    expect(store.remove('material', saved.id)).toBe(true);
    expect(readFileSync(segment.path).length).toBeGreaterThan(0);
    expect(store.list('material')).toHaveLength(1);
  });

  it('未下载的媒体、无授权源文件、写盘失败都不会回报保存成功', async () => {
    const path = root();
    const store = new MergeForwardArchiveStore(join(path, 'archive'));
    const input = {
      id: 'draft-fail',
      nodes: [{ id: 'n1', sender, time: 1, segs: [{ t: 'image', path: '' }] }],
    };
    await expect(store.append('history', input)).rejects.toThrow('媒体尚未下载');
    await expect(
      store.append('history', {
        ...input,
        nodes: [
          {
            ...input.nodes[0]!,
            segs: [{ t: 'opaque', element: { type: 'pic', data: { md5: 'synthetic' } } }],
          },
        ],
      }),
    ).rejects.toThrow('媒体尚未下载');
    const source = join(path, 'source.png');
    writeFileSync(source, 'fixture');
    input.nodes[0]!.segs[0]!.path = source;
    await expect(store.append('material', input, async () => false)).rejects.toThrow(
      '媒体访问未授权',
    );
    expect(store.list('history')).toEqual([]);
    const blocked = join(path, 'not-a-directory');
    writeFileSync(blocked, 'fixture');
    await expect(
      new MergeForwardArchiveStore(blocked).append('history', { id: 'draft', nodes: [] }),
    ).rejects.toThrow();
  });

  it('身份不能越过目录，损坏的历史不伪装成空列表', async () => {
    const path = root();
    const store = new MergeForwardArchiveStore(path);
    expect(() => store.get('history', '../escape')).toThrow('归档身份不合法');
    const saved = await store.append('history', { id: 'draft', nodes: [] });
    writeFileSync(join(path, 'history', `${saved.id}.json`), '{broken');
    expect(() => store.list('history')).toThrow('归档记录损坏');
  });
});
