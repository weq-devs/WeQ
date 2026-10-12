import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CollectionMediaStore, collectionMediaReferences } from '../src/account/collection_media';
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
    const exported = await exportCollections(
      { format: 'json', outputPath },
      { listCollections: async (_limit, offset) => (offset === 0 ? [row] : []) },
    );

    const result = JSON.parse(await readFile(outputPath, 'utf8')) as Array<Record<string, string>>;
    expect(result[0]?.body).toBe(full);
    expect(result[0]?.fullContentFormat).toBe('html');
    expect(result[0]?.contentStatus).toBe('详情已读取');
    expect(exported.coverage).toMatchObject({
      detailsReceived: 1,
      detailsUncovered: 0,
      bodies: { 'full-html': 1 },
      originalsComplete: false,
      serverCountVerified: false,
      items: [{ cid: 'cid-rich', body: 'full-html', originalQuality: 'unverified' }],
    });

    const mixed = await exportCollections(
      { format: 'json', outputPath },
      {
        listCollections: async () => [
          row,
          {
            ...row,
            cid: 'truncated',
            contentStatus: 'truncated',
            fullContent: '',
            fullContentFormat: null,
          },
          { ...row, cid: 'binary', fullContent: '', fullContentFormat: 'binary' },
          { ...row, cid: 'empty-text', fullContent: '', fullContentFormat: 'text' },
          { ...row, cid: 'no-extra', kind: 'link', fullContent: '', fullContentFormat: null },
        ],
      },
    );
    expect(mixed.coverage).toMatchObject({
      rows: 5,
      detailsReceived: 4,
      detailsUncovered: 1,
      bodies: {
        'full-text': 1,
        'full-html': 1,
        'binary-unrendered': 1,
        'no-extra-body': 1,
        'truncated-summary': 1,
      },
      mediaDownloadState: 'not-requested',
    });
    const mixedRows = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(mixedRows[3].body).toBe('');
    expect(mixedRows[1].body).toBe('截断摘要');
    expect(mixedRows[2].bodyCoverage).toBe('binary-unrendered');
    expect(mixedRows[4].mediaCoverage).toBe('未下载，原件质量未核验');

    const filtered = await exportCollections(
      { format: 'json', outputPath, kinds: ['link'] },
      {
        listCollections: async () => [row, { ...row, cid: 'link-only', kind: 'link' }],
      },
    );
    expect(filtered.coverage.rows).toBe(1);
    expect(filtered.coverage.items.map((entry) => entry.cid)).toEqual(['link-only']);

    const bytes = Buffer.from('synthetic-collection-original');
    const [reference] = collectionMediaReferences(row.cid, {
      recordTime: 0,
      richMediaContent: {
        picList: [
          {
            uri: 'https://shp.qpic.cn/synthetic/0',
            name: 'original.png',
            size: bytes.length,
            md5: createHash('md5').update(bytes).digest(),
          },
        ],
      },
    });
    const media = new CollectionMediaStore(join(dir, 'cache'));
    await media.download(reference!, {
      fetch: async () => new Response(bytes),
      inspectImage: async () => ({ width: 1, height: 1 }),
    });
    const withMedia = await exportCollections(
      { format: 'json', outputPath },
      {
        listCollections: async () => [{ ...row }],
        exportCachedMedia: async (_cid, directory, signal) => [
          await media.exportCached(reference!, directory, signal),
        ],
      },
    );
    expect(withMedia.coverage).toMatchObject({
      originalsComplete: false,
      mediaReferencesComplete: false,
      mediaDownloadState: 'cached-only',
      attachments: [{ state: 'downloaded', role: 'original', md5Matches: true, sizeMatches: true }],
    });
    const attachment = withMedia.coverage.attachments[0]!;
    expect(await readFile(join(dir, attachment.file!))).toEqual(bytes);
    expect(JSON.parse(await readFile(outputPath, 'utf8'))[0].mediaCoverage).toContain('原件 1');
  });
});
