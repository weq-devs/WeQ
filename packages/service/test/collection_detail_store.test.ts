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
});
