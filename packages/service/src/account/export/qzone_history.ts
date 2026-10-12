import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
  } | null;
  activeTids: string[];
  completeTids: string[];
  items: Record<string, { latest: string; revisions: QzoneHistoryRevision[] }>;
  rawPages: Array<{ pos: number; sha256: string; file: string; capturedAt: number }>;
}

export interface QzoneHistorySummary {
  items: number;
  revisions: number;
  rawPages: number;
  nextPos: number;
  termination: QzonePageCapture['termination'] | null;
}

function empty(targetUin: string): QzoneHistoryLedger {
  return {
    version: 1,
    targetUin,
    updatedAt: 0,
    checkpoint: null,
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

  resumeState(): { startPos: number; anchorTids: string[]; rows: QzonePageCapture['rows'] } | null {
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
      rows: this.ledger.activeTids
        .map((tid) => this.ledger.items[tid]?.revisions.at(-1)?.row)
        .filter((row): row is QzonePageCapture['rows'][number] => Boolean(row)),
    };
  }

  savePage(page: QzonePageCapture): void {
    if (page.targetUin !== this.targetUin) throw new Error('空间历史目标账号不匹配。');
    const capturedAt = Date.now();
    mkdirSync(join(this.root, 'raw'), { recursive: true });
    for (const [index, raw] of (page.rawResponses ?? []).entries()) {
      const sha256 = createHash('sha256').update(raw).digest('hex');
      const file = `raw/page-${page.pos}-${index}-${sha256}.txt`;
      writeFileAtomicSync(join(this.root, file), raw);
      if (!this.ledger.rawPages.some((entry) => entry.sha256 === sha256))
        this.ledger.rawPages.push({ pos: page.pos, sha256, file, capturedAt });
    }
    if (page.pos === 0) this.ledger.activeTids = [];
    const active = new Set(this.ledger.activeTids);
    for (const row of page.rows) {
      const sha256 = sourceVersionHash(row);
      const current = this.ledger.items[row.tid] ?? { latest: '', revisions: [] };
      if (!current.revisions.some((revision) => revision.sha256 === sha256))
        current.revisions.push({ sha256, capturedAt, row });
      current.latest = sha256;
      this.ledger.items[row.tid] = current;
      if (!active.has(row.tid)) {
        active.add(row.tid);
        this.ledger.activeTids.push(row.tid);
      }
    }
    this.ledger.updatedAt = capturedAt;
    this.ledger.checkpoint = {
      nextPos: page.nextPos,
      termination: page.termination,
      anchorTids: page.rows.slice(-5).map((row) => row.tid),
    };
    if (['empty-page', 'stable-tail', 'time-range'].includes(page.termination)) {
      this.ledger.completeTids = [...this.ledger.activeTids];
      this.ledger.activeTids = [];
    }
    writeFileAtomicSync(this.ledgerPath, JSON.stringify(this.ledger, null, 2));
  }

  summary(): QzoneHistorySummary {
    return {
      items: Object.keys(this.ledger.items).length,
      revisions: Object.values(this.ledger.items).reduce(
        (total, item) => total + item.revisions.length,
        0,
      ),
      rawPages: this.ledger.rawPages.length,
      nextPos: this.ledger.checkpoint?.nextPos ?? 0,
      termination: this.ledger.checkpoint?.termination ?? null,
    };
  }

  writeSnapshot(path: string): void {
    writeFileAtomicSync(path, JSON.stringify(this.ledger, null, 2));
  }
}
