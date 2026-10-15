import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { publishRawHistory } from '../../common/publish_raw_history';
import { writeFileAtomicSync } from '../../common/atomic_write';
import { readJsonFile } from '../../common/json_store';
import { sourceVersionHash } from '../collection_capture';
import type { QzonePageCapture } from './qzone_export';

export interface QzoneHistoryRevision {
  sha256: string;
  capturedAt: number;
  row: QzonePageCapture['rows'][number];
}

interface QzoneHistoryLedger {
  version: 1;
  targetUin: string;
  updatedAt: number;
  checkpoint: {
    nextPos: number;
    termination: QzonePageCapture['termination'];
    anchorTids: string[];
    anchors?: Array<{ tid: string; time: number }>;
  } | null;
  interactionRawPages: Array<{
    kind: 'feeds' | 'comments' | 'likes';
    tid: string | null;
    sha256: string;
    file: string;
    capturedAt: number;
  }>;
  activeTids: string[];
  completeTids: string[];
  items: Record<string, { latest: string; revisions: QzoneHistoryRevision[] }>;
  rawPages: Array<{ pos: number; sha256: string; file: string; capturedAt: number }>;
}

export interface QzoneHistorySummary {
  items: number;
  revisions: number;
  rawPages: number;
  interactionRawPages: number;
  nextPos: number;
  termination: QzonePageCapture['termination'] | null;
}

function empty(targetUin: string): QzoneHistoryLedger {
  return {
    version: 1,
    targetUin,
    updatedAt: 0,
    checkpoint: null,
    interactionRawPages: [],
    activeTids: [],
    completeTids: [],
    items: {},
    rawPages: [],
  };
}

function normalize(raw: unknown, targetUin: string): QzoneHistoryLedger {
  if (!raw || typeof raw !== 'object') return empty(targetUin);
  const value = raw as Partial<QzoneHistoryLedger>;
  if (value.version !== 1 || value.targetUin !== targetUin || !value.items) return empty(targetUin);
  return {
    version: 1,
    targetUin,
    updatedAt: Number(value.updatedAt ?? 0),
    checkpoint: value.checkpoint ?? null,
    interactionRawPages: Array.isArray(value.interactionRawPages) ? value.interactionRawPages : [],
    activeTids: Array.isArray(value.activeTids) ? value.activeTids : [],
    completeTids: Array.isArray(value.completeTids) ? value.completeTids : [],
    items: value.items,
    rawPages: Array.isArray(value.rawPages) ? value.rawPages : [],
  };
}

/** Persistent per-account/per-target history. The surrounding export queue serializes writers. */
export class QzoneHistoryStore {
  private readonly root: string;
  private readonly ledgerPath: string;
  private ledger: QzoneHistoryLedger;

  constructor(
    cacheDir: string,
    readonly targetUin: string,
  ) {
    const key = createHash('sha256').update(targetUin).digest('hex').slice(0, 24);
    this.root = join(cacheDir, 'qzone-history', key);
    this.ledgerPath = join(this.root, 'ledger.json');
    this.ledger = normalize(readJsonFile(this.ledgerPath), targetUin);
  }

  resumeState(): {
    startPos: number;
    anchorTids: string[];
    anchors: Array<{ tid: string; time: number }>;
    rows: QzonePageCapture['rows'];
  } | null {
    const checkpoint = this.ledger.checkpoint;
    if (
      !checkpoint ||
      this.ledger.activeTids.length === 0 ||
      !['more', 'repeated-page'].includes(checkpoint.termination)
    )
      return null;
    return {
      startPos: checkpoint.nextPos,
      anchorTids: checkpoint.anchorTids ?? [],
      anchors: checkpoint.anchors ?? [],
      rows: this.ledger.activeTids
        .map((tid) => {
          const item = this.ledger.items[tid];
          return item?.revisions.find((revision) => revision.sha256 === item.latest)?.row;
        })
        .filter((row): row is QzonePageCapture['rows'][number] => Boolean(row)),
    };
  }

  savePage(page: QzonePageCapture): void {
    if (page.targetUin !== this.targetUin) throw new Error('空间历史目标账号不匹配。');
    if (page.rows.some((row) => !row.tid)) throw new Error('空间条目缺少 ID。');
    const next = structuredClone(this.ledger);
    next.items = Object.assign(Object.create(null), next.items);
    const capturedAt = Date.now();
    mkdirSync(join(this.root, 'raw'), { recursive: true });
    for (const [index, raw] of (page.rawResponses ?? []).entries()) {
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const file = `raw/page-${page.pos}-${index}-${sha256}.txt`;
      writeFileAtomicSync(join(this.root, file), raw);
      if (!next.rawPages.some((entry) => entry.sha256 === sha256))
        next.rawPages.push({
          pos: page.requestPositions?.[index] ?? page.pos,
          sha256,
          file,
          capturedAt,
        });
    }
    if (page.pos === 0 && !page.continuation) next.activeTids = [];
    const active = new Set(next.activeTids);
    for (const row of page.rows) {
      const sha256 = sourceVersionHash(row);
      const current = next.items[row.tid] ?? { latest: '', revisions: [] };
      if (!current.revisions.some((revision) => revision.sha256 === sha256))
        current.revisions.push({ sha256, capturedAt, row });
      current.latest = sha256;
      next.items[row.tid] = current;
      if (!active.has(row.tid)) {
        active.add(row.tid);
        next.activeTids.push(row.tid);
      }
    }
    next.updatedAt = capturedAt;
    next.checkpoint = {
      nextPos: page.nextPos,
      termination: page.termination,
      anchorTids: (page.anchors ?? page.rows.slice(-5)).map((row) => row.tid),
      anchors: page.anchors ?? page.rows.slice(-5).map((row) => ({ tid: row.tid, time: row.time })),
    };
    if (['empty-page', 'stable-tail', 'time-range'].includes(page.termination)) {
      next.completeTids = [...next.activeTids];
      next.activeTids = [];
    }
    writeFileAtomicSync(this.ledgerPath, JSON.stringify(next, null, 2));
    this.ledger = next;
  }

  saveInteractionRaw(capture: {
    kind: 'feeds' | 'comments' | 'likes';
    tid?: string;
    response: string;
  }): void {
    const sha256 = createHash('sha256').update(capture.response).digest('hex');
    const file = `interaction-raw/${capture.kind}-${sha256}.txt`;
    writeFileAtomicSync(join(this.root, file), capture.response);
    const next = structuredClone(this.ledger);
    const tid = capture.tid ?? null;
    if (
      !next.interactionRawPages.some(
        (entry) => entry.kind === capture.kind && entry.tid === tid && entry.sha256 === sha256,
      )
    ) {
      const capturedAt = Date.now();
      next.interactionRawPages.push({ kind: capture.kind, tid, sha256, file, capturedAt });
      next.updatedAt = capturedAt;
    }
    writeFileAtomicSync(this.ledgerPath, JSON.stringify(next, null, 2));
    this.ledger = next;
  }

  summary(): QzoneHistorySummary {
    return {
      items: Object.keys(this.ledger.items).length,
      revisions: Object.values(this.ledger.items).reduce(
        (total, item) => total + item.revisions.length,
        0,
      ),
      rawPages: this.ledger.rawPages.length,
      interactionRawPages: this.ledger.interactionRawPages.length,
      nextPos: this.ledger.checkpoint?.nextPos ?? 0,
      termination: this.ledger.checkpoint?.termination ?? null,
    };
  }

  writeSnapshot(path: string): void {
    publishRawHistory(
      this.root,
      path,
      [...this.ledger.rawPages, ...this.ledger.interactionRawPages],
      /^(raw\/page-\d+-\d+-[a-f0-9]{64}\.txt|interaction-raw\/(feeds|comments|likes)-[a-f0-9]{64}\.txt)$/,
    );
    writeFileAtomicSync(path, JSON.stringify(this.ledger, null, 2));
  }
}
