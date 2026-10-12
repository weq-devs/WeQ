import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exportCollections,
  type CollectionExportRow,
} from '../src/account/export/collection_export';

describe('collection export official-client cache', () => {
  let dir = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'collection-export-cache-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('exports cached full HTML ahead of the truncated list summary', async () => {
    const full = '<div><span>完整正文</span><br></div>';
    const row: CollectionExportRow = {
      contentStatus: 'cached',
      fullContent: full,
      fullContentFormat: 'html',
      textTruncated: true,
      cid: 'cid-rich',
      kind: 'richMedia',
      type: 8,
      createTime: 1000,
      collectTime: 3000,
      authorName: '作者',
      authorUin: '10001',
      groupName: '',
      text: '',
      link: null,
      gallery: null,
      audio: null,
      video: null,
      file: null,
      location: null,
      richMedia: {
        title: '',
        subTitle: '',
        brief: '截断摘要',
        originalUri: '',
        pics: [],
      },
    };
    const outputPath = join(dir, 'collections.json');
    await exportCollections(
      { format: 'json', outputPath },
      { listCollections: async (_limit, offset) => (offset === 0 ? [row] : []) },
    );

    const result = JSON.parse(await readFile(outputPath, 'utf8')) as Array<Record<string, string>>;
    expect(result[0]?.body).toBe(full);
    expect(result[0]?.fullContentFormat).toBe('html');
    expect(result[0]?.contentStatus).toBe('详情已读取');
  });
});
