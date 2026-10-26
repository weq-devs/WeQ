import { describe, expect, it } from 'vitest';
import { groupFlashDownloads } from '../src/account/flashtransfer/batches';
import type { FlashDownloadTask } from '../src/account/flashtransfer/types';

const file = (id: string, overrides: Partial<FlashDownloadTask> = {}): FlashDownloadTask => ({
  id,
  batchId: 'operation-a',
  filesetId: 'set',
  filesetName: '资料',
  name: `${id}.txt`,
  physicalId: id,
  relativePath: `${id}.txt`,
  targetPath: `/fixture/${id}.txt`,
  fileSize: 100,
  downloadedBytes: 0,
  status: 'pending',
  createdAt: 10,
  ...overrides,
});

describe('闪传按下载操作归并', () => {
  it('同次多文件只占一项，不合并同一分享的另一次操作或旧记录', () => {
    const result = groupFlashDownloads([
      file('a', { status: 'done', downloadedBytes: 100 }),
      file('b', { status: 'downloading', downloadedBytes: 25, fileSize: 300 }),
      file('c', { batchId: 'operation-b' }),
      file('old-a', { batchId: undefined }),
      file('old-b', { batchId: undefined }),
    ]);
    expect(result.map((batch) => batch.id)).toEqual([
      'operation-a',
      'operation-b',
      'old-a',
      'old-b',
    ]);
    expect(result[0]).toMatchObject({
      name: '资料',
      fileSize: 400,
      downloadedBytes: 125,
      status: 'downloading',
    });
    expect(result[0]!.files).toHaveLength(2);
  });

  it('其他文件尚未结束时保持活动，全部结束后不能把部分失败或取消当成功', () => {
    expect(groupFlashDownloads([file('a', { status: 'failed' }), file('b')])[0]!.status).toBe(
      'pending',
    );
    for (const status of ['failed', 'cancelled', 'done'] as const) {
      expect(
        groupFlashDownloads([file('a', { status }), file('b', { status: 'done' })])[0]!.status,
      ).toBe(status);
    }
    expect(
      groupFlashDownloads([file('a', { status: 'done', resolutionErrors: ['子目录解析失败'] })])[0],
    ).toMatchObject({ status: 'failed', error: '子目录解析失败' });
  });
});
