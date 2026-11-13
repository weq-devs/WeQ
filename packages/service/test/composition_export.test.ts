import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { writeCompositionBundle } from '../src/account/export/composition_export';
import { normalizeMergeForwardDraft } from '../src/account/merge_forward_drafts';

it('合成资源包保留嵌套结构，媒体按内容去重，缺失项不影响其他成果且不改原草稿', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-composition-export-'));
  try {
    const source = join(root, 'a.png');
    const duplicate = join(root, 'b.jpg');
    await writeFile(source, 'same');
    await writeFile(duplicate, 'same');
    const input = {
      id: 'draft-1',
      title: '合成记录',
      nodes: [
        {
          id: 'n1',
          sender: { uid: '', uin: '10001', name: '合成人物' },
          time: 100,
          segs: [
            { t: 'image', id: 'i1', path: source },
            {
              t: 'node',
              id: 'nested',
              segs: [
                { t: 'image', id: 'i2', path: duplicate },
                { t: 'file', id: 'f1', path: join(root, 'missing') },
              ],
            },
          ],
        },
      ],
    };
    const before = structuredClone(input);
    const output = join(root, 'output');
    await mkdir(output);
    const result = await writeCompositionBundle(
      input,
      { directory: output, signal: new AbortController().signal, progress: vi.fn() },
      async () => true,
    );
    expect(result).toMatchObject({ total: 4, ok: 3, failed: [{ fileName: 'missing' }] });
    const data = JSON.parse(await readFile(join(output, 'composition.json'), 'utf8'));
    expect(data.resources).toHaveLength(1);
    expect(data.draft.nodes[0].segs[0].path).toBe(data.draft.nodes[0].segs[1].segs[0].path);
    expect(await readFile(join(output, data.resources[0].path), 'utf8')).toBe('same');
    expect(input).toEqual(before);
    expect(normalizeMergeForwardDraft(before, input.id)?.nodes).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('无缓存图片及原样媒体先补全，再写包内引用，不修改原来的预览和草稿', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-composition-online-'));
  try {
    const source = join(root, 'downloaded.jpg');
    await writeFile(source, 'image-bytes');
    const preview = { type: 'pic', data: { fileToken: 'stable-token', originalUrl: '/original' } };
    const input = {
      id: 'draft-online',
      nodes: [
        {
          id: 'n',
          sender: { uid: '', uin: '10001', name: '合成人物' },
          time: 100,
          sourceMsgId: '23',
          segs: [
            { t: 'image', id: 'image', path: '', preview },
            { t: 'opaque', id: 'original', element: preview },
          ],
        },
      ],
    };
    const before = structuredClone(input),
      resolve = vi.fn(async () => source);
    const directory = join(root, 'bundle');
    const result = await writeCompositionBundle(
      input,
      { directory, signal: new AbortController().signal, progress() {} },
      async () => true,
      resolve,
    );
    expect(result.failed).toEqual([]);
    const output = JSON.parse(await readFile(join(directory, 'composition.json'), 'utf8'));
    expect(output.resources).toHaveLength(1);
    expect(output.draft.nodes[0].segs[0].path).toBe(output.draft.nodes[0].segs[1].exportPath);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceMsgId: '23', time: 100 }),
      expect.any(AbortSignal),
    );
    expect(input).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
