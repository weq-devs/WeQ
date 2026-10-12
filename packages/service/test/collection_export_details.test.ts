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
