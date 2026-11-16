import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { FlashTransferDownloadManager } from '../src/account/flashtransfer/manager';
import { FlashTransferResolver } from '../src/account/flashtransfer/resolver';
import { FlashTransferClient } from '../src/account/flashtransfer/client';
import { groupFlashDownloads } from '../src/account/flashtransfer/batches';
import type { FlashDownloadTask } from '../src/account/flashtransfer/types';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('闪传保留真实阶段日志并随任务持久化，批量日志序号稳定且不重复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-flash-logs-'));
  roots.push(root);
  const state = join(root, 'state');
  const output = join(root, 'output');
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
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))),
  );
  const manager = new FlashTransferDownloadManager(state);
  await manager.start('batch', 'set', [], output);
  await vi.waitFor(() => expect(manager.list()[0]?.status).toBe('done'));
  const task = manager.list()[0];
  const text = task.logs?.map((line) => line.text).join('\n');
  expect(text).toContain('等待下载');
  expect(text).toContain('获取下载链接');
  expect(text).toContain('下载中');
  expect(text).toContain('文件已保存');
  expect(new Set(task.logs?.map((line) => line.seq)).size).toBe(task.logs?.length);
  await vi.waitFor(async () => {
    const reloaded = new FlashTransferDownloadManager(state);
    await reloaded.load();
    expect(reloaded.list()[0].logs).toEqual(task.logs);
  });
});

it('批量日志按时间归并且只保留最近 300 条，窗口滚动后原日志 key 不变', () => {
  const files = [0, 1].map(
    (index): FlashDownloadTask => ({
      id: `file-${index}`,
      batchId: 'batch',
      name: 'file',
      filesetName: 'batch',
      filesetId: 'set',
      physicalId: 'physical',
      relativePath: `file-${index}.bin`,
      targetPath: `/synthetic/file-${index}.bin`,
      status: 'downloading',
      fileSize: 100,
      downloadedBytes: 40,
      createdAt: 1,
      logs: Array.from({ length: 200 }, (_, seq) => ({
        ts: seq * 10 + index,
        seq,
        stage: 'downloading',
        level: 'info',
        text: `file-${index}-${seq}`,
      })),
    }),
  );
  const logs = groupFlashDownloads(files)[0].logs!;
  expect(logs).toHaveLength(300);
  expect(new Set(logs.map((line) => line.seq)).size).toBe(300);
  const before = logs.at(-1)!;
  files[0].logs!.push({ ts: 3000, seq: 200, stage: 'done', level: 'info', text: '完成' });
  const next = groupFlashDownloads(files)[0].logs!;
  expect(next.find((line) => line.text === before.text)?.seq).toBe(before.seq);
  expect(next.at(-1)?.text).toBe('完成');
});
