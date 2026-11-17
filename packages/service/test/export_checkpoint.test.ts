import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportCheckpoint } from '../src/account/export/checkpoint';
import { exportAvatars } from '../src/account/export/avatar_export';
import type { AvatarCacheService } from '../src/bootstrap/media_cache';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-export-checkpoint-'));
  roots.push(root);
  return root;
}

it('重启后复用完成结果，保留 Map、字节与 bigint，读取副本不修改快照', async () => {
  const root = fixture();
  const load = vi.fn(async () => new Map([['a', { id: 1n, bytes: Buffer.from('ok') }]]));
  const first = await new ExportCheckpoint(root).run(['page', 0], load);
  first.clear();
  const restored = await new ExportCheckpoint(root).run(['page', 0], load);
  expect(restored.get('a')).toEqual({ id: 1n, bytes: Buffer.from('ok') });
  expect(load).toHaveBeenCalledTimes(1);
});

it('失败不提交断点；成功文件校验后复用，内容变化不能假冒完成', async () => {
  const root = fixture();
  const file = join(root, 'result.txt');
  const load = vi.fn(async () => {
    writeFileSync(file, 'complete');
    if (load.mock.calls.length === 1) throw new Error('interrupted');
    return 7;
  });
  const checkpoint = new ExportCheckpoint(join(root, 'state'));
  await expect(checkpoint.file('format', file, load)).rejects.toThrow('interrupted');
  await expect(checkpoint.file('format', file, load)).resolves.toBe(7);
  await expect(new ExportCheckpoint(join(root, 'state')).file('format', file, load)).resolves.toBe(
    7,
  );
  expect(load).toHaveBeenCalledTimes(2);
  writeFileSync(file, 'changed');
  await expect(checkpoint.file('format', file, load)).rejects.toThrow(/续作文件/);
});

it('暂停只提交已成功的操作，未完成操作恢复后重试，同键并发只执行一次', async () => {
  const root = fixture();
  const abort = new AbortController();
  const checkpoint = new ExportCheckpoint(root, abort.signal);
  const load = vi.fn(async () => {
    abort.abort();
    return 'saved';
  });
  await expect(checkpoint.run('finished-in-flight', load)).rejects.toThrow();
  await expect(new ExportCheckpoint(root).run('finished-in-flight', load)).resolves.toBe('saved');
  const next = new ExportCheckpoint(root);
  const concurrent = vi.fn(async () => 'one');
  await Promise.all([next.run('same', concurrent), next.run('same', concurrent)]);
  expect(concurrent).toHaveBeenCalledTimes(1);
});

it('已完成目录新增文件也不被当作原完成结果发布', async () => {
  const root = fixture();
  const directory = join(root, 'files');
  const checkpoint = new ExportCheckpoint(join(root, 'state'));
  await checkpoint.file('directory', directory, async () => {
    mkdirSync(directory);
    writeFileSync(join(directory, 'owned.txt'), 'original');
  });
  writeFileSync(join(directory, 'extra.txt'), 'different');
  await expect(checkpoint.file('directory', directory, async () => {})).rejects.toThrow(/续作文件/);
});

it('头像返回时已经暂停但尚未写盘，不提交空的完成记录，恢复仍写入该头像', async () => {
  const root = fixture();
  const abort = new AbortController();
  const get = vi.fn(async () => {
    if (get.mock.calls.length === 1) abort.abort();
    return { data: Buffer.from('synthetic'), contentType: 'image/png' };
  });
  const cache = { get } as unknown as AvatarCacheService;
  const state = join(root, 'state');
  await expect(
    exportAvatars(cache, ['10001'], root, {
      signal: abort.signal,
      checkpoint: new ExportCheckpoint(state, abort.signal),
    }),
  ).rejects.toThrow();
  await expect(
    exportAvatars(cache, ['10001'], root, { checkpoint: new ExportCheckpoint(state) }),
  ).resolves.toMatchObject({ ok: 1 });
  expect(get).toHaveBeenCalledTimes(2);
  expect(existsSync(join(root, 'avatars', '10001.png'))).toBe(true);
});
