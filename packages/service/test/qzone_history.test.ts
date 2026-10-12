import { mkdirSync, readdirSync, renameSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  it('uses the latest observation even when content reverts to an existing revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-qzone-history-'));
    roots.push(root);
    const store = new QzoneHistoryStore(root, '10001');
    const page = {
      targetUin: '10001',
      pos: 0,
      nextPos: 15,
      total: 40,
      rows: [row('before')],
      termination: 'more' as const,
    };
    store.savePage(page);
    store.savePage({ ...page, rows: [row('after')] });
    store.savePage(page);
    expect(store.resumeState()?.rows[0]?.content).toBe('before');
    expect(store.summary().revisions).toBe(2);
    expect(store.resumeState()?.anchors).toEqual([{ tid: 'tid-1', time: 1 }]);
  });

  it('preserves active IDs when a relocated page returns to the head', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-qzone-history-'));
    roots.push(root);
    const store = new QzoneHistoryStore(root, '10001');
    const page = {
      targetUin: '10001',
      pos: 0,
      nextPos: 15,
      total: 40,
      rows: [row('before')],
      termination: 'more' as const,
    };
    store.savePage(page);
    store.savePage({ ...page, continuation: true, rows: [{ ...row('new'), tid: 'tid-2' }] });
    expect(store.resumeState()?.rows.map((entry) => entry.tid)).toEqual(['tid-1', 'tid-2']);
  });

  it('does not advance in-memory versions or checkpoint after a failed atomic write', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-qzone-history-'));
    roots.push(root);
    const store = new QzoneHistoryStore(root, '10001');
    const page = {
      targetUin: '10001',
      pos: 0,
      nextPos: 15,
      total: 40,
      rows: [row('before')],
      termination: 'more' as const,
    };
    store.savePage(page);
    const folder = join(root, 'qzone-history', readdirSync(join(root, 'qzone-history'))[0]!);
    const ledger = join(folder, 'ledger.json');
    renameSync(ledger, ledger + '.old');
    mkdirSync(ledger);
    expect(() =>
      store.savePage({
        ...page,
        pos: 15,
        nextPos: 30,
        rows: [row('after')],
        rawResponses: ['synthetic raw'],
      }),
    ).toThrow();
    expect(store.resumeState()).toMatchObject({ startPos: 15, rows: [{ content: 'before' }] });
    expect(store.summary().revisions).toBe(1);
    rmSync(ledger, { recursive: true });
    renameSync(ledger + '.old', ledger);
    expect(new QzoneHistoryStore(root, '10001').resumeState()?.rows[0]?.content).toBe('before');
  });
  it('keeps raw interaction fields and bindings without advancing the body checkpoint', () => {
    const root = mkdtempSync(join(tmpdir(), 'weq-qzone-history-'));
    roots.push(root);
    const store = new QzoneHistoryStore(root, '10001');
    store.savePage({
      targetUin: '10001',
      pos: 0,
      nextPos: 15,
      total: 40,
      rows: [row('before')],
      termination: 'more',
    });
    const response = '_Callback({"code":0,"unknown":{"retained":true}});';
    store.saveInteractionRaw({ kind: 'likes', tid: 'tid-1', response });
    store.saveInteractionRaw({ kind: 'likes', tid: 'tid-1', response });
    store.saveInteractionRaw({ kind: 'likes', tid: 'tid-2', response });
    expect(store.summary()).toMatchObject({ nextPos: 15, interactionRawPages: 2, revisions: 1 });
    const snapshot = join(root, 'snapshot.json');
    store.writeSnapshot(snapshot);
    const saved = JSON.parse(readFileSync(snapshot, 'utf8'));
    const folder = join(root, 'qzone-history', readdirSync(join(root, 'qzone-history'))[0]!);
    expect(readFileSync(join(folder, saved.interactionRawPages[0].file), 'utf8')).toBe(response);
    expect(readFileSync(join(root, saved.interactionRawPages[0].file), 'utf8')).toBe(response);
    expect(() => store.writeSnapshot(snapshot)).not.toThrow();
    expect(new QzoneHistoryStore(root, '10001').resumeState()?.rows[0]?.content).toBe('before');
  });
});
