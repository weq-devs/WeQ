/**
 * `ExportTaskManager` 的「导出表情包」任务端到端单测。
 *
 * 用一个假的表情源 + 假的下载器驱动 runEmojiPackTask，验证：
 *   - 三段阶段（扫描 / 补全原图 / 导出图片）都会跑完并置为 completed；
 *   - 缺失原图的条目走下载补全、下载失败退到缩略图、都没有才记失败；
 *   - 产物落在 bundle 下的「我的表情 / 收到的表情」两个子目录。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { EmojiExportItem } from '../src/account/export/emoji_export';

const GIF = Buffer.from('4749463839610100010000003b', 'hex');
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8db00000000049454e44ae426082',
  'hex',
);

let roots: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'weq-emojipack-'));
  roots.push(d);
  return d;
}
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function put(root: string, rel: string, bytes: Buffer): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, bytes);
  return abs;
}

/** 等任务跑到终态（监听 progress 事件）。 */
function waitDone(mgr: ExportTaskManager, taskId: string): Promise<void> {
  return new Promise((resolve) => {
    const tick = (): void => {
      const t = mgr.getTask(taskId);
      if (t && ['completed', 'failed', 'cancelled'].includes(t.status)) {
        clearInterval(iv);
        resolve();
      }
    };
    const iv = setInterval(tick, 20);
    tick();
  });
}

describe('ExportTaskManager · 导出表情包', () => {
  it('runs scan → download → write and lands two source folders', async () => {
    const root = tmp();
    const mgr = new ExportTaskManager({} as never, join(root, 'cache'), {
      emojipack: {
        listOwnItems: async (): Promise<EmojiExportItem[]> => [
          {
            key: 'aaaa11',
            oriPath: put(root, 'p/Ori/aaaa11.jpg', PNG),
            thumbPath: null,
            remoteUrl: 'https://cdn/a',
          },
          {
            key: 'bbbb22',
            oriPath: null,
            thumbPath: put(root, 'p/Thumb/bbbb22.png', PNG),
            remoteUrl: 'https://cdn/b',
          },
          { key: 'cccc33', oriPath: null, thumbPath: null, remoteUrl: 'https://cdn/c' },
          { key: 'eeee55', oriPath: null, thumbPath: null, remoteUrl: 'https://cdn/e' },
        ],
        listReceivedItems: async (): Promise<EmojiExportItem[]> => [
          {
            key: 'dddd44',
            oriPath: put(root, 'r/Ori/dddd44.gif', GIF),
            thumbPath: null,
            remoteUrl: null,
          },
        ],
        // a 本地已有原图（不是下载候选）；b、c、e 缺原图 → 候选 3 张。
        // e 下载成功；b 下载失败但有缩略图 → 退到缩略图；c 下载失败且无缩略图 → 记失败。
        downloadImage: async (url, dest) => {
          if (url === 'https://cdn/e') {
            writeFileSync(dest, PNG);
            return true;
          }
          return false;
        },
      },
    });

    const id = await mgr.startEmojiPackExport(['own', 'received']);
    await waitDone(mgr, id);

    const task = mgr.getTask(id)!;
    expect(task.status).toBe('completed');
    const byKey = new Map(task.stages.map((s) => [s.key, s]));
    expect(byKey.get('emojiscan')!.status).toBe('completed');
    expect(byKey.get('emojiscan')!.total).toBe(5);
    expect(byKey.get('emojidownload')!.status).toBe('completed');
    expect(byKey.get('emojidownload')!.total).toBe(3);
    expect(byKey.get('emojidownload')!.note).toContain('成功 1');
    expect(byKey.get('emojidownload')!.note).toContain('失败 2');
    expect(byKey.get('emojiwrite')!.status).toBe('completed');

    const ownDir = join(task.bundleDir!, '我的表情');
    const recvDir = join(task.bundleDir!, '收到的表情');
    expect(readdirSync(ownDir)).toHaveLength(3); // a 原图 + e 下载 + b 缩略图
    expect(readdirSync(recvDir)).toHaveLength(1); // d 原图
    expect(existsSync(join(task.bundleDir!, '.cache'))).toBe(false); // 临时下载目录已清
    const writeFailures = byKey.get('emojiwrite')!.failures ?? [];
    expect(writeFailures.some((f) => f.fileName.includes('cccc33'))).toBe(true);
  });
});
