import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonFile } from '../common/json_store';
import { publishRawHistory } from '../common/publish_raw_history';
import { encodeStructured, decodeStructured } from '../common/structured_json';
import { writeFileAtomicSync } from '../common/atomic_write';
import type { CollectionCaptureCheckpoint, CollectionPageCapture } from './collection_capture';

interface CollectionHistoryLedger {
  version: 1;
  uin: string;
  updatedAt: number;
  activeCheckpoint: CollectionCaptureCheckpoint | null;
  latest: Record<string, string>;
  versions: Record<
    string,
    Array<{ sha256: string; capturedAt: number; item: CollectionPageCapture['items'][number] }>
  >;
  rawPages: Array<{ sha256: string; cursor: string; capturedAt: number; file: string }>;
  lastComplete: {
    uniqueItems: number;
    reportedTotal: number | null;
    completedAt: number;
  } | null;
}

export interface CollectionHistorySummary {
  items: number;
  revisions: number;
  rawPages: number;
  complete: boolean;
  uniqueItems: number;
  reportedTotal: number | null;
}

function empty(uin: string): CollectionHistoryLedger {
  return {
    version: 1,
    uin,
    updatedAt: 0,
    activeCheckpoint: null,
    latest: {},
    versions: {},
    rawPages: [],
    lastComplete: null,
  };
}

function normalize(raw: unknown, uin: string): CollectionHistoryLedger {
  if (!raw || typeof raw !== 'object') return empty(uin);
  const value = raw as Partial<CollectionHistoryLedger>;
  if (value.version !== 1 || value.uin !== uin) return empty(uin);
  return {
    ...empty(uin),
    ...value,
    version: 1,
    uin,
    latest: value.latest ?? {},
    versions: value.versions ?? {},
    rawPages: Array.isArray(value.rawPages) ? value.rawPages : [],
  };
}

export class CollectionHistoryStore {
  private readonly ledgerPath: string;
  private ledger: CollectionHistoryLedger;

  constructor(
    private readonly root: string,
    readonly uin: string,
  ) {
    this.ledgerPath = join(root, 'ledger.json');
    this.ledger = normalize(decodeStructured(readJsonFile(this.ledgerPath)), uin);
  }

  checkpointForResume(): CollectionCaptureCheckpoint | undefined {
    return this.ledger.activeCheckpoint ?? undefined;
  }

  savePage(page: CollectionPageCapture): void {
    if (page.checkpoint.uin !== this.uin) throw new Error('收藏历史账号不匹配。');
    const next = structuredClone(this.ledger);
    next.latest = Object.assign(Object.create(null), next.latest);
    next.versions = Object.assign(Object.create(null), next.versions);
    const capturedAt = Date.now();
    const sha256 = createHash('sha256').update(page.rawResponse).digest('hex');
    const cursor = page.checkpoint.cursor?.timeStamp ?? 'terminal';
    const file = `raw/page-${page.checkpoint.pages}-${cursor}-${sha256}.bin`;
    writeFileAtomicSync(join(this.root, file), page.rawResponse);
    if (!next.rawPages.some((entry) => entry.sha256 === sha256))
      next.rawPages.push({ sha256, cursor, capturedAt, file });
    for (const [index, item] of page.items.entries()) {
      const version = page.versions[index];
      if (!version || version.cid !== item.cid) throw new Error('收藏版本与条目不匹配。');
      const revisions = next.versions[item.cid] ?? [];
      if (!revisions.some((entry) => entry.sha256 === version.sha256))
        revisions.push({ sha256: version.sha256, capturedAt, item });
      next.versions[item.cid] = revisions;
      next.latest[item.cid] = version.sha256;
    }
    next.updatedAt = capturedAt;
    next.activeCheckpoint = page.checkpoint.complete ? null : page.checkpoint;
    if (page.checkpoint.complete) {
      next.lastComplete = {
        uniqueItems: page.checkpoint.uniqueItems,
        reportedTotal: page.checkpoint.reportedTotal,
        completedAt: capturedAt,
      };
    }
    writeFileAtomicSync(this.ledgerPath, JSON.stringify(encodeStructured(next), null, 2));
    this.ledger = next;
  }

  getByCid(cid: string): CollectionPageCapture['items'][number] | null {
    const sha = this.ledger.latest[cid];
    const item = this.ledger.versions[cid]?.find((entry) => entry.sha256 === sha)?.item;
    return item ? structuredClone(item) : null;
  }

  summary(): CollectionHistorySummary {
    return {
      items: Object.keys(this.ledger.latest).length,
      revisions: Object.values(this.ledger.versions).reduce(
        (total, revisions) => total + revisions.length,
        0,
      ),
      rawPages: this.ledger.rawPages.length,
      complete: this.ledger.activeCheckpoint === null && this.ledger.lastComplete !== null,
      uniqueItems: this.ledger.lastComplete?.uniqueItems ?? 0,
      reportedTotal: this.ledger.lastComplete?.reportedTotal ?? null,
    };
  }

  writeSnapshot(path: string): void {
    publishRawHistory(
      this.root,
      path,
      this.ledger.rawPages,
      /^raw\/page-\d+-(?:\d+|terminal)-[a-f0-9]{64}\.bin$/,
    );
    writeFileAtomicSync(path, JSON.stringify(encodeStructured(this.ledger), null, 2));
  }
}
