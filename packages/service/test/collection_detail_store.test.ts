import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionDetailStore } from '../src/account/collection_detail_store';

let roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'weq-collection-details-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe('CollectionDetailStore', () => {
  it('persists raw bytes before committing a round-trippable detail ledger', () => {
    const root = makeRoot();
    const store = new CollectionDetailStore(root, '10001');
    const raw = Uint8Array.of(1, 2, 3, 4);
    const capture = store.saveRawBatch(['cid-rich'], raw);

    expect(readFileSync(join(root, capture.responseFile))).toEqual(Buffer.from(raw));
    expect(existsSync(join(root, 'accounts/10001/detail-ledger.json'))).toBe(false);

    store.commitBatch(
      [
        {
          cid: 'cid-rich',
          content: {
            recordTime: 1,
            richMedia: Uint8Array.of(9, 8),
            richMediaContent: {
              rawData: '<div>完整内容</div>',
              fileList: [{ name: '资料.txt', size: 12n }],
            },
          },
        },
      ],
      capture,
    );

    const reopened = new CollectionDetailStore(root, '10001');
    expect(reopened.get('cid-rich')).toMatchObject({
      fetched: true,
      richMedia: Uint8Array.of(9, 8),
      richMediaContent: {
        rawData: '<div>完整内容</div>',
        fileList: [{ name: '资料.txt', size: 12n }],
      },
    });
    expect(reopened.count()).toBe(1);
  });

  it('keeps successful empty detail responses as completed', () => {
    const root = makeRoot();
    const store = new CollectionDetailStore(root, '10001');
    store.saveBatch([{ cid: 'cid-link', content: { recordTime: 0 } }], Uint8Array.of(7));
    expect(store.get('cid-link')).toMatchObject({ fetched: true });
  });

  it('falls back safely when a ledger is damaged', () => {
    const root = makeRoot();
    const ledger = join(root, 'accounts/10001/detail-ledger.json');
    mkdirSync(join(root, 'accounts/10001'), { recursive: true });
    writeFileSync(ledger, '{not-json', { encoding: 'utf8', flag: 'w' });
    const store = new CollectionDetailStore(root, '10001');
    expect(store.count()).toBe(0);
    expect(store.get('anything')).toBeNull();
  });

  it('isolates ledgers and raw responses by account', () => {
    const root = makeRoot();
    const first = new CollectionDetailStore(root, '10001');
    const second = new CollectionDetailStore(root, '10002');
    first.saveBatch([{ cid: 'shared-cid', content: { recordTime: 0 } }], Uint8Array.of(1));
    second.saveBatch(
      [{ cid: 'shared-cid', content: { recordTime: 0, textContent: { data: 'second' } } }],
      Uint8Array.of(2),
    );

    expect(first.get('shared-cid')?.textContent).toBeUndefined();
    expect(second.get('shared-cid')?.textContent?.data).toBe('second');
    expect(existsSync(join(root, 'accounts/10001/detail-ledger.json'))).toBe(true);
    expect(existsSync(join(root, 'accounts/10002/detail-ledger.json'))).toBe(true);
  });

  it('refuses to advance a capture with reordered details', () => {
    const root = makeRoot();
    const store = new CollectionDetailStore(root, '10001');
    const capture = store.saveRawBatch(['first', 'second'], Uint8Array.of(1, 2));
    expect(() =>
      store.commitBatch(
        [
          { cid: 'second', content: { recordTime: 0 } },
          { cid: 'first', content: { recordTime: 0 } },
        ],
        capture,
      ),
    ).toThrow('顺序');
    expect(store.count()).toBe(0);
  });

  it('does not partially commit earlier rows when a later row is invalid', () => {
    const root = makeRoot();
    const store = new CollectionDetailStore(root, '10001');
    const capture = store.saveRawBatch(['first', 'second'], Uint8Array.of(1));
    expect(() =>
      store.commitBatch(
        [
          { cid: 'first', content: { recordTime: 0 } },
          { cid: 'wrong', content: { recordTime: 0 } },
        ],
        capture,
      ),
    ).toThrow('顺序');
    expect(store.get('first')).toBeNull();
    expect(store.count()).toBe(0);
    expect(new CollectionDetailStore(root, '10001').count()).toBe(0);
  });

  it('keeps the old in-memory cache when the ledger cannot be published', () => {
    const root = makeRoot();
    const store = new CollectionDetailStore(root, '10001');
    const capture = store.saveRawBatch(['new'], Uint8Array.of(1));
    mkdirSync(join(root, 'accounts/10001/detail-ledger.json'));
    expect(() =>
      store.commitBatch([{ cid: 'new', content: { recordTime: 0 } }], capture),
    ).toThrow();
    expect(store.get('new')).toBeNull();
    expect(store.count()).toBe(0);
  });

  it('rejects missing, altered and foreign-account raw responses', () => {
    const root = makeRoot();
    const store = new CollectionDetailStore(root, '10001');
    const capture = store.saveRawBatch(['cid'], Uint8Array.of(1));
    const details = [{ cid: 'cid', content: { recordTime: 0 } }];
    const other = new CollectionDetailStore(root, '10002');
    expect(() => other.commitBatch(details, capture)).toThrow('路径');
    writeFileSync(join(root, capture.responseFile), Uint8Array.of(2));
    expect(() => store.commitBatch(details, capture)).toThrow('校验');
    rmSync(join(root, capture.responseFile));
    expect(() => store.commitBatch(details, capture)).toThrow();
    expect(store.count()).toBe(0);
  });

  it('does not treat inherited names or malformed ledger entries as cached details', () => {
    const root = makeRoot();
    const store = new CollectionDetailStore(root, '10001');
    expect(store.get('constructor')).toBeNull();
    store.saveBatch([{ cid: '__proto__', content: { recordTime: 0 } }], Uint8Array.of(1));
    expect(new CollectionDetailStore(root, '10001').get('__proto__')?.fetched).toBe(true);
    writeFileSync(
      join(root, 'accounts/10001/detail-ledger.json'),
      JSON.stringify({
        version: 1,
        uin: '10001',
        latest: { broken: { content: { fetched: true } } },
      }),
    );
    expect(new CollectionDetailStore(root, '10001').get('broken')).toBeNull();
  });
});
