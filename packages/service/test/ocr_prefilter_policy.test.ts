import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ExportTaskManager } from '../src/account/export/task_manager';
import type { MsgService } from '../src/account/msg';

it.each([true, false])('导出以实时全局筛图策略 %s 为准，不受旧请求参数覆盖', async (enabled) => {
  const root = await mkdtemp(join(tmpdir(), 'weq-ocr-policy-'));
  try {
    const ntDataDir = join(root, 'nt_data');
    const picDir = join(ntDataDir, 'Pic', '2026-11', 'Ori');
    await mkdir(picDir, { recursive: true });
    await writeFile(join(picDir, 'sample.png'), 'fixture');
    const msgs = {
      countConv: async () => 1,
      takeSalvageSkips: () => [],
      async *exportC2cMessages() {
        yield {
          msgId: 1n,
          msgSeq: 1n,
          targetUid: 'peer',
          targetUin: 10002n,
          senderUid: 'peer',
          senderUin: 10002n,
          sendTime: BigInt(Date.UTC(2026, 10, 10) / 1000),
          elements: [
            { type: 'pic', data: { fileName: 'sample.png', imgWidth: 100, imgHeight: 100 } },
          ],
        };
      },
    } as unknown as MsgService;
    const filter = vi.fn(async () => ({ ok: true, hasText: false }));
    const local = vi.fn(async () => ({ ok: true, text: 'fixture text' }));
    const manager = new ExportTaskManager(msgs, join(root, 'cache'), {
      ntDataDir,
      ocrLocal: local,
      ocrFilter: filter,
      ocrPrefilterEnabled: () => enabled,
    });
    const id = await manager.startTask({
      kind: 'c2c',
      conv: 'peer',
      name: 'OCR 策略',
      format: 'txt',
      total: 1,
      includeIntegrityReport: false,
      savePolicy: { mode: 'before', directory: join(root, 'output') },
      media: { ocrImages: true, ocrPrefilter: !enabled },
    });
    await vi.waitFor(() =>
      expect(manager.getTask(id)?.status, manager.getTask(id)?.error).toBe('completed'),
    );
    expect(filter).toHaveBeenCalledTimes(enabled ? 1 : 0);
    expect(local).toHaveBeenCalledTimes(enabled ? 0 : 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
