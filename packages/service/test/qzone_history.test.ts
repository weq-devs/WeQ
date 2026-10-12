import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { QzoneHistoryStore } from '../src/account/export/qzone_history';
import type { QzoneEmotion } from '../src/account/web/qzone';

let roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

const row = (content: string): QzoneEmotion => ({
  tid: 'tid-1',
  content,
  time: 1,
  commentNum: 0,
  isPrivate: false,
  images: [],
  videos: [],
});

describe('qzone history store', () => {
  it('deduplicates unchanged rows and preserves revisions and raw pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-qzone-history-'));
    roots.push(root);
    const store = new QzoneHistoryStore(root, '10001');
    const page = {
      targetUin: '10001',
      pos: 0,
      nextPos: 1,
      total: 1,
      rows: [row('before')],
      rawResponses: ['{"page":1}'],
      termination: 'more' as const,
    };
    store.savePage(page);
    expect(store.resumeState()).toMatchObject({
      startPos: 1,
      anchorTids: ['tid-1'],
      rows: [{ tid: 'tid-1', content: 'before' }],
    });
    store.savePage(page);
    store.savePage({
      ...page,
      rows: [row('after')],
      rawResponses: ['{"page":2}'],
      termination: 'stable-tail',
    });
    expect(store.resumeState()).toBeNull();
    expect(store.summary()).toMatchObject({ items: 1, revisions: 2, rawPages: 2 });
    const snapshot = join(root, 'snapshot.json');
    store.writeSnapshot(snapshot);
    const saved = JSON.parse(readFileSync(snapshot, 'utf8'));
    expect(
      saved.items['tid-1'].revisions.map((entry: { row: QzoneEmotion }) => entry.row.content),
    ).toEqual(['before', 'after']);
  });

  it('rejects a page for another target', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-qzone-history-'));
    roots.push(root);
    const store = new QzoneHistoryStore(root, '10001');
    expect(() =>
      store.savePage({
        targetUin: '20002',
        pos: 0,
        nextPos: 0,
        total: 0,
        rows: [],
        termination: 'empty-page',
      }),
    ).toThrow('目标账号不匹配');
  });
});
