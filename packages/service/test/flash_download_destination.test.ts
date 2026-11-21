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
  const completed = new Set<string>();
  manager.on('task', (task) => {
    if (task.status === 'done') completed.add(task.id);
  });
  const waitForCompleted = () =>
    vi.waitFor(() => {
      const files = manager.list().flatMap((task) => task.files);
      expect(files.length).toBeGreaterThan(0);
      expect(files.every((file) => file.status === 'done' && completed.has(file.id))).toBe(true);
    });
  return { root, state, output, manager, waitForCompleted };
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
  await f.waitForCompleted();
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
  await f.waitForCompleted();
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

it('取消收尾完成后可重试原闪传任务，重复点击不会重复下载，完成文件不再下载', async () => {
  const f = await fixture();
  let release!: (url: string) => void;
  const url = vi.spyOn(FlashTransferClient.prototype, 'getDownloadUrl');
  url.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { taskId } = await f.manager.start('batch', 'set', [], f.output);
  await vi.waitFor(() => expect(release).toBeDefined());
  await f.manager.cancel(taskId!);
  expect(f.manager.list()[0]?.canRetry).toBe(false);
  expect(await f.manager.retry(taskId!)).toBe(false);
  release('https://synthetic.invalid/file');
  await vi.waitFor(() => expect(f.manager.list()[0]?.canRetry).toBe(true));
  expect(await f.manager.retry(taskId!)).toBe(true);
  expect(await f.manager.retry(taskId!)).toBe(false);
  await f.waitForCompleted();
  expect(await f.manager.retry(taskId!)).toBe(false);
  expect(url).toHaveBeenCalledTimes(2);
  expect(f.manager.list()).toHaveLength(1);
  expect((await readFile(f.manager.list()[0]!.targetPath)).length).toBe(4);
});

it('混合完成与取消的闪传只重试取消文件，原成品内容和路径保留', async () => {
  const f = await fixture();
  vi.spyOn(FlashTransferResolver.prototype, 'resolveDownloads').mockResolvedValue({
    files: ['one', 'two'].map((name) => ({
      name,
      relativePath: `${name}.bin`,
      physicalId: name,
      filesetId: 'set',
      fileSize: 4,
    })),
    errors: [],
  });
  let release!: (url: string) => void;
  const url = vi.spyOn(FlashTransferClient.prototype, 'getDownloadUrl');
  url.mockImplementationOnce(async () => 'https://synthetic.invalid/one');
  url.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const { taskId } = await f.manager.start('batch', 'set', [], f.output);
  await vi.waitFor(() => expect(f.manager.list()[0]?.files[0]?.status).toBe('done'));
  const saved = f.manager.list()[0]!.files[0]!.targetPath;
  const content = await readFile(saved);
  await f.manager.cancel(taskId!);
  release('https://synthetic.invalid/two');
  await vi.waitFor(() => expect(f.manager.list()[0]?.canRetry).toBe(true));
  expect(await f.manager.retry(taskId!)).toBe(true);
  await f.waitForCompleted();
  expect(url.mock.calls).toEqual([['one'], ['two'], ['two']]);
  expect(f.manager.list()[0]?.files[0]?.targetPath).toBe(saved);
  expect(await readFile(saved)).toEqual(content);
});
