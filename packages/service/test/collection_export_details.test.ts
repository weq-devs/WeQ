import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  exportCollections,
  type CollectionExportRow,
} from '../src/account/export/collection_export';
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});
function rows(count: number): CollectionExportRow[] {
  return Array.from({ length: count }, (_, i) => ({
    cid: `cid-${i}`,
    type: 1,
    kind: 'text',
    createTime: 0,
    collectTime: 0,
    authorName: '',
    authorUin: '',
    groupName: '',
    text: 'summary',
    contentStatus: 'truncated',
    textTruncated: true,
    link: null,
    gallery: null,
    audio: null,
    video: null,
    file: null,
    location: null,
    richMedia: null,
  }));
}
function output() {
  root = mkdtempSync(join(tmpdir(), 'weq-export-detail-'));
  return join(root, 'collection.json');
}

describe('collection export detail hydration', () => {
  it('renders source timestamps in Beijing time without rewriting raw source fields', async () => {
    const outputPath = output();
    const source = rows(1);
    source[0]!.createTime = Date.parse('2026-10-16T17:02:03Z');
    await exportCollections(
      { format: 'json', outputPath },
      { listCollections: async () => source },
    );
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))[0].createTime).toBe('2026-10-17 01:02');
    expect(source[0]!.createTime).toBe(Date.parse('2026-10-16T17:02:03Z'));
  });
  it('exports only exact selected CIDs and never fetches unrelated details', async () => {
    const outputPath = output();
    const fetchDetails = vi.fn(async (cids: string[]) =>
      cids.map((cid) => ({
        cid,
        contentStatus: 'cached' as const,
        fullContent: `全文 ${cid}`,
        fullContentFormat: 'text' as const,
      })),
    );
    const result = await exportCollections(
      { format: 'json', outputPath, cids: ['cid-1'] },
      { listCollections: async () => rows(3), fetchDetails },
    );
    expect(result.count).toBe(1);
    expect(fetchDetails).toHaveBeenCalledWith(['cid-1'], undefined);
    expect(
      JSON.parse(readFileSync(outputPath, 'utf8')).map((row: { cid: string }) => row.cid),
    ).toEqual(['cid-1']);
  });
  it('does not turn a missing selected CID into an apparently successful empty export', async () => {
    await expect(
      exportCollections(
        { format: 'json', outputPath: output(), cids: ['missing'] },
        { listCollections: async () => rows(2) },
      ),
    ).rejects.toThrow('部分选中的收藏');
  });
  it('fetches bounded batches and publishes full bodies ahead of summaries', async () => {
    const source = rows(45);
    const outputPath = output();
    const fetchDetails = vi.fn(async (cids: string[]) =>
      cids.map((cid) => ({
        cid,
        contentStatus: 'cached' as const,
        fullContent: `full ${cid}`,
        fullContentFormat: 'text' as const,
      })),
    );
    const result = await exportCollections(
      { format: 'json', outputPath },
      { listCollections: async () => source, fetchDetails },
    );
    expect(fetchDetails.mock.calls.map((call) => call[0].length)).toEqual([20, 20, 5]);
    expect(result.coverage).toMatchObject({
      detailsReceived: 45,
      detailsFailed: 0,
      originalsComplete: false,
    });
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))[44].body).toBe('full cid-44');
  });
  it('keeps summaries and separates failed requests from skipped offline rows', async () => {
    const outputPath = output();
    const fetchDetails = vi.fn(async () => {
      throw new Error('完全离线模式');
    });
    const result = await exportCollections(
      { format: 'json', outputPath },
      { listCollections: async () => rows(45), fetchDetails },
    );
    expect(fetchDetails).toHaveBeenCalledOnce();
    expect(result.coverage).toMatchObject({
      detailsReceived: 0,
      detailsFailed: 20,
      detailsUncovered: 45,
    });
    expect(result.coverage.items[20]?.detail).toBe('uncovered');
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))[0].body).toBe('summary');
  });
  it('rejects mismatched batches without applying wrong-account or wrong-CID bodies', async () => {
    const outputPath = output();
    const result = await exportCollections(
      { format: 'json', outputPath },
      {
        listCollections: async () => rows(2),
        fetchDetails: async () => [
          {
            cid: 'wrong-cid',
            contentStatus: 'cached',
            fullContent: 'wrong',
            fullContentFormat: 'text',
          },
        ],
      },
    );
    expect(result.coverage.detailsFailed).toBe(2);
    expect(
      JSON.parse(readFileSync(outputPath, 'utf8')).map((row: { body: string }) => row.body),
    ).toEqual(['summary', 'summary']);
  });
  it('does not hydrate cached bodies or publish after cancellation', async () => {
    const outputPath = output();
    const controller = new AbortController();
    const fetchDetails = vi.fn(async () => {
      controller.abort();
      return [];
    });
    await expect(
      exportCollections(
        { format: 'json', outputPath, signal: controller.signal },
        { listCollections: async () => rows(2), fetchDetails },
      ),
    ).rejects.toBeDefined();
    const cached = {
      ...rows(1)[0]!,
      contentStatus: 'cached' as const,
      fullContent: 'cached',
      fullContentFormat: 'text' as const,
    };
    fetchDetails.mockClear();
    expect(
      (
        await exportCollections(
          { format: 'json', outputPath },
          { listCollections: async () => [cached], fetchDetails },
        )
      ).coverage.detailsReceived,
    ).toBe(1);
    expect(fetchDetails).not.toHaveBeenCalled();
  });
  it('does not attempt network details when offline capability is explicitly disabled', async () => {
    const outputPath = output();
    const fetchDetails = vi.fn(async () => []);
    const result = await exportCollections(
      { format: 'json', outputPath },
      {
        listCollections: async () => rows(45),
        canFetchDetails: () => false,
        fetchDetails,
      },
    );
    expect(fetchDetails).not.toHaveBeenCalled();
    expect(result.coverage).toMatchObject({
      detailsReceived: 0,
      detailsFailed: 0,
      detailsUncovered: 45,
    });
  });
});

describe('collection export file/video acquisition', () => {
  it('acquires before copying and reports attempts without claiming full coverage', async () => {
    const calls: string[] = [];
    const source = rows(2);
    for (const row of source) row.contentStatus = 'cached';
    const result = await exportCollections(
      { format: 'json', outputPath: output() },
      {
        listCollections: async () => source,
        canFetchDetails: () => true,
        downloadOriginalFiles: async (cid) => {
          calls.push(`fetch:${cid}`);
          return { failed: 0 };
        },
        exportCachedMedia: async (cid) => {
          calls.push(`copy:${cid}`);
          return [];
        },
      },
    );
    expect(calls).toEqual(['fetch:cid-0', 'copy:cid-0', 'fetch:cid-1', 'copy:cid-1']);
    expect(result.coverage.mediaDownloadState).toBe('requested');
    expect(result.coverage.originalsComplete).toBe(false);
  });
  it('exports cached attachments offline without any application requests', async () => {
    const downloadOriginalFiles = vi.fn();
    const source = rows(1);
    const result = await exportCollections(
      { format: 'json', outputPath: output() },
      {
        listCollections: async () => source,
        canFetchDetails: () => false,
        downloadOriginalFiles,
        exportCachedMedia: async () => [],
      },
    );
    expect(downloadOriginalFiles).not.toHaveBeenCalled();
    expect(result.coverage.mediaDownloadState).toBe('cached-only');
  });
  it('stops new applications after three failed rows while retaining cached exports', async () => {
    const downloadOriginalFiles = vi.fn(async () => ({ failed: 1 }));
    const exportCachedMedia = vi.fn(async () => []);
    const result = await exportCollections(
      { format: 'json', outputPath: output() },
      { listCollections: async () => rows(5), downloadOriginalFiles, exportCachedMedia },
    );
    expect(downloadOriginalFiles).toHaveBeenCalledTimes(3);
    expect(exportCachedMedia).toHaveBeenCalledTimes(5);
    expect(result.coverage.items.map((item) => item.media)).toEqual([
      'requested',
      'requested',
      'requested',
      'cached-only',
      'cached-only',
    ]);
  });
});

describe('collection original download request budget', () => {
  it('does not reset failures on text rows or already cached attachments', async () => {
    const downloadOriginalFiles = vi.fn(async (cid: string) =>
      ['cid-0', 'cid-2', 'cid-4'].includes(cid)
        ? { failed: 1, attempted: 1 }
        : { failed: 0, attempted: 0 },
    );
    const result = await exportCollections(
      { format: 'json', outputPath: output() },
      {
        listCollections: async () => rows(7),
        downloadOriginalFiles,
        exportCachedMedia: async () => [],
      },
    );
    expect(downloadOriginalFiles.mock.calls.map((call) => call[0])).toEqual([
      'cid-0',
      'cid-1',
      'cid-2',
      'cid-3',
      'cid-4',
    ]);
    expect(result.coverage.items.map((item) => item.media)).toEqual([
      'requested',
      'cached-only',
      'requested',
      'cached-only',
      'requested',
      'cached-only',
      'cached-only',
    ]);
  });
  it('stops after a rejected credential, rate limit or unsupported client while copying caches', async () => {
    const downloadOriginalFiles = vi.fn(async () => ({
      failed: 1,
      attempted: 1,
      stopRequests: true,
    }));
    const exportCachedMedia = vi.fn(async () => []);
    const result = await exportCollections(
      { format: 'json', outputPath: output() },
      { listCollections: async () => rows(4), downloadOriginalFiles, exportCachedMedia },
    );
    expect(downloadOriginalFiles).toHaveBeenCalledTimes(1);
    expect(exportCachedMedia).toHaveBeenCalledTimes(4);
    expect(result.coverage.items.slice(1).every((item) => item.media === 'cached-only')).toBe(true);
  });
});
