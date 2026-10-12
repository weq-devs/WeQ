import { mkdirSync, renameSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionHistoryStore } from '../src/account/collection_history';
import type { CollectionItem } from '@weq/db';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const item = (text: string) =>
  ({ cid: 'cid-1', summary: { textSummary: { text } } }) as CollectionItem;

describe('collection history store', () => {
  it('preserves source revisions, raw pages and resumable checkpoints', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-collection-history-'));
    roots.push(root);
    const store = new CollectionHistoryStore(root, '10001');
    const first = item('before');
    store.savePage({
      items: [first],
      versions: [{ cid: first.cid, sha256: 'a'.repeat(64) }],
      checkpoint: {
        version: 1,
        uin: '10001',
        cursor: { timeStamp: '10', sequence: 2 },
        pages: 1,
        observedItems: 1,
        uniqueItems: 1,
        seenCids: ['cid-1'],
        reportedTotal: 1,
        complete: false,
        lastPageHash: 'page-a',
      },
      reportedTotal: 1,
      contentCoverage: 'list-summaries',
      rawResponse: Uint8Array.of(1, 2, 3),
    });
    expect(store.checkpointForResume()?.cursor?.timeStamp).toBe('10');

    const revised = item('after');
    store.savePage({
      items: [revised],
      versions: [{ cid: revised.cid, sha256: 'b'.repeat(64) }],
      checkpoint: {
        version: 1,
        uin: '10001',
        cursor: null,
        pages: 2,
        observedItems: 2,
        uniqueItems: 1,
        seenCids: ['cid-1'],
        reportedTotal: 1,
        complete: true,
        lastPageHash: 'page-b',
      },
      reportedTotal: 1,
      contentCoverage: 'list-summaries',
      rawResponse: Uint8Array.of(4, 5, 6),
    });
    expect(store.checkpointForResume()).toBeUndefined();
    expect(store.summary()).toMatchObject({
      items: 1,
      revisions: 2,
      rawPages: 2,
      complete: true,
      uniqueItems: 1,
    });
    const snapshot = join(root, 'snapshot.json');
    store.writeSnapshot(snapshot);
    const saved = JSON.parse(readFileSync(snapshot, 'utf8'));
    expect(
      saved.versions['cid-1'].map(
        (entry: { item: CollectionItem }) => entry.item.summary.textSummary.text,
      ),
    ).toEqual(['before', 'after']);
  });
  it('round-trips bigint identities and byte hashes through a durable ledger', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-collection-history-'));
    roots.push(root);
    const store = new CollectionHistoryStore(root, '10001');
    const source = {
      ...item('text'),
      author: { numId: 10001n },
      summary: {
        richMediaSummary: { picList: [{ md5: Uint8Array.of(1, 2, 3), size: 12 }] },
        fileSummary: { fileInfo: { size: 9007199254740993n } },
      },
    } as CollectionItem;
    store.savePage({
      items: [source],
      versions: [{ cid: source.cid, sha256: 'a'.repeat(64) }],
      checkpoint: {
        version: 1,
        uin: '10001',
        cursor: { timeStamp: '10', sequence: 2 },
        pages: 1,
        observedItems: 1,
        uniqueItems: 1,
        seenCids: ['cid-1'],
        reportedTotal: 1,
        complete: false,
      },
      reportedTotal: 1,
      contentCoverage: 'list-summaries',
      rawResponse: Uint8Array.of(1),
    });
    const reopened = new CollectionHistoryStore(root, '10001');
    expect(reopened.getByCid('cid-1')?.author?.numId).toBe(10001n);
    expect(reopened.getByCid('cid-1')?.summary.fileSummary?.fileInfo?.size).toBe(9007199254740993n);
    expect(reopened.getByCid('cid-1')?.summary.richMediaSummary?.picList?.[0]?.md5).toEqual(
      Uint8Array.of(1, 2, 3),
    );
    expect(reopened.checkpointForResume()?.cursor?.timeStamp).toBe('10');
    renameSync(join(root, 'ledger.json'), join(root, 'ledger.old'));
    mkdirSync(join(root, 'ledger.json'));
    expect(() =>
      reopened.savePage({
        items: [item('changed')],
        versions: [{ cid: 'cid-1', sha256: 'b'.repeat(64) }],
        checkpoint: {
          version: 1,
          uin: '10001',
          cursor: null,
          pages: 2,
          observedItems: 2,
          uniqueItems: 1,
          seenCids: ['cid-1'],
          reportedTotal: 1,
          complete: true,
        },
        reportedTotal: 1,
        contentCoverage: 'list-summaries',
        rawResponse: Uint8Array.of(2),
      }),
    ).toThrow();
    expect(reopened.checkpointForResume()?.cursor?.timeStamp).toBe('10');
    expect(reopened.getByCid('cid-1')?.author?.numId).toBe(10001n);
  });
});
