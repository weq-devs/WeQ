import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FlashTransferDownloadManager } from '../src/account/flashtransfer/manager';
import { FlashTransferResolver } from '../src/account/flashtransfer/resolver';
import { FlashTransferClient } from '../src/account/flashtransfer/client';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weq-flash-output-'));
  roots.push(root);
  const state = join(root, 'state');
  const output = join(root, 'output');
  await mkdir(state);
  await mkdir(output);
  vi.spyOn(FlashTransferResolver.prototype, 'resolveDownloads').mockResolvedValue({
    files: [
      {
        name: 'file.bin',
        relativePath: 'file.bin',
        physicalId: 'physical',
        filesetId: 'set',
        fileSize: 4,
      },
    ],
    errors: [],
  });
  vi.spyOn(FlashTransferClient.prototype, 'getDownloadUrl').mockResolvedValue(
    'https://synthetic.invalid/file',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
    ),
  );
  const manager = new FlashTransferDownloadManager(state);
  await manager.load();
  return { root, state, output, manager };
}
it('成品与任务状态分离，连续同名下载不覆盖已有文件，清任务不删成品', async () => {
  const f = await fixture();
  const existing = join(f.output, 'batch', 'FILE.BIN');
  await mkdir(dirname(existing));
  await writeFile(existing, 'original');
  await Promise.all([
    f.manager.start('batch', 'set', [], f.output),
    f.manager.start('batch', 'set', [], f.output),
  ]);
  await vi.waitFor(() =>
    expect(f.manager.list().every((task) => task.status === 'done')).toBe(true),
  );
  const files = f.manager.list().flatMap((task) => task.files);
  expect(new Set(files.map((file) => file.targetPath)).size).toBe(2);
  expect(files.every((file) => file.targetPath.startsWith(f.output))).toBe(true);
  expect(await readFile(existing, 'utf8')).toBe('original');
  expect(JSON.parse(await readFile(join(f.state, 'tasks.json'), 'utf8'))).toHaveLength(2);
  await f.manager.clearCompleted(f.manager.list().map((task) => task.id));
  for (const file of files) expect((await readFile(file.targetPath)).length).toBe(4);
});
it('新任务目录变化不影响旧记录 targetPath，目标失效不能写回状态目录', async () => {
  const f = await fixture();
  const first = await f.manager.start('batch', 'set', [], f.output);
  const other = join(f.root, 'other');
  await mkdir(other);
  await f.manager.start('batch', 'set', [], other);
  await vi.waitFor(() =>
    expect(f.manager.list().every((task) => task.status === 'done')).toBe(true),
  );
  expect(
    f.manager
      .list()
      .find((task) => task.id === first.taskId)
      ?.targetPath.startsWith(f.output),
  ).toBe(true);
  const reloaded = new FlashTransferDownloadManager(f.state);
  await reloaded.load();
  expect(
    reloaded
      .list()
      .find((task) => task.id === first.taskId)
      ?.targetPath.startsWith(f.output),
  ).toBe(true);
  await expect(f.manager.start('batch', 'set', [], join(f.root, 'missing'))).rejects.toThrow();
  expect(f.manager.list()).toHaveLength(2);
});
