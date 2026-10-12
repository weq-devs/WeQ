import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CollectionCachedContent } from '@weq/db';
import { writeFileAtomicSync } from '../common/atomic_write';
import { readJsonFile } from '../common/json_store';
import type { CollectionNetworkDetail } from './web/collection';

type StoredValue =
  | null
  | boolean
  | number
  | string
  | StoredValue[]
  | { [key: string]: StoredValue };

interface DetailLedgerEntry {
  capturedAt: number;
  responseSha256: string;
  responseFile: string;
  responseIndex: number;
  content: StoredValue;
}

interface DetailLedger {
  version: 1;
  uin: string;
  updatedAt: number;
  latest: Record<string, DetailLedgerEntry>;
}

export interface CollectionDetailRawCapture {
  capturedAt: number;
  cids: readonly string[];
  responseSha256: string;
  responseFile: string;
}

function empty(uin: string): DetailLedger {
  return { version: 1, uin, updatedAt: 0, latest: Object.create(null) };
}

function validEntry(value: unknown, uin: string): value is DetailLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<DetailLedgerEntry>;
  return (
    typeof entry.capturedAt === 'number' &&
    Number.isFinite(entry.capturedAt) &&
    typeof entry.responseSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.responseSha256) &&
    entry.responseFile === `accounts/${uin}/detail-raw/${entry.responseSha256}.bin` &&
    Number.isSafeInteger(entry.responseIndex) &&
    Number(entry.responseIndex) >= 0 &&
    Boolean(entry.content && typeof entry.content === 'object' && !Array.isArray(entry.content))
  );
}

function normalize(value: unknown, uin: string): DetailLedger {
  if (!value || typeof value !== 'object') return empty(uin);
  const ledger = value as Partial<DetailLedger>;
  if (ledger.version !== 1 || ledger.uin !== uin) return empty(uin);
  const latest: Record<string, DetailLedgerEntry> = Object.create(null);
  if (ledger.latest && typeof ledger.latest === 'object' && !Array.isArray(ledger.latest)) {
    for (const [cid, entry] of Object.entries(ledger.latest)) {
      if (validEntry(entry, uin)) latest[cid] = entry;
    }
  }
  return {
    version: 1,
    uin,
    updatedAt: Number.isFinite(ledger.updatedAt) ? Number(ledger.updatedAt) : 0,
    latest,
  };
}

function encodeValue(value: unknown): StoredValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('收藏详情包含非法数字。');
    return value;
  }
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (typeof value === 'object') {
    const output: Record<string, StoredValue> = {};
    for (const [key, field] of Object.entries(value)) {
      if (field !== undefined) output[key] = encodeValue(field);
    }
    return output;
  }
  throw new Error(`收藏详情包含不支持的值：${typeof value}`);
}

function decodeValue(value: StoredValue): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(decodeValue);
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.$bytes === 'string') {
    return new Uint8Array(Buffer.from(value.$bytes, 'base64'));
  }
  if (keys.length === 1 && typeof value.$bigint === 'string' && /^\d+$/.test(value.$bigint)) {
    return BigInt(value.$bigint);
  }
  return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, decodeValue(field)]));
}

export class CollectionDetailStore {
  private readonly ledgerPath: string;
  private ledger: DetailLedger;

  constructor(
    private readonly root: string,
    readonly uin: string,
  ) {
    if (!/^[1-9]\d*$/.test(uin)) throw new Error('收藏详情账号无效。');
    this.ledgerPath = join(root, 'accounts', uin, 'detail-ledger.json');
    this.ledger = normalize(readJsonFile(this.ledgerPath), uin);
  }

  get(cid: string): CollectionCachedContent | null {
    const entry = this.ledger.latest[cid];
    if (!entry) return null;
    try {
      const content = decodeValue(entry.content);
      if (!content || typeof content !== 'object' || Array.isArray(content)) return null;
      const decoded = content as CollectionCachedContent;
      return decoded.fetched === true && Number.isFinite(decoded.recordTime) ? decoded : null;
    } catch {
      return null;
    }
  }

  getMany(cids: readonly string[]): Map<string, CollectionCachedContent> {
    const result = new Map<string, CollectionCachedContent>();
    for (const cid of cids) {
      const content = this.get(cid);
      if (content) result.set(cid, content);
    }
    return result;
  }

  /** Persist the exact server response before any completion state is advanced. */
  saveRawBatch(cids: readonly string[], rawResponse: Uint8Array): CollectionDetailRawCapture {
    if (cids.length === 0) throw new Error('收藏详情批次为空。');
    if (cids.some((cid) => !cid)) throw new Error('收藏详情缺少 CID。');
    const capturedAt = Date.now();
    const sha256 = createHash('sha256').update(rawResponse).digest('hex');
    const responseFile = `accounts/${this.uin}/detail-raw/${sha256}.bin`;
    writeFileAtomicSync(join(this.root, responseFile), rawResponse);
    return {
      capturedAt,
      cids: [...cids],
      responseSha256: sha256,
      responseFile,
    };
  }

  /** Commit decoded detail rows only after their raw response is durable. */
  commitBatch(
    details: readonly CollectionNetworkDetail[],
    capture: CollectionDetailRawCapture,
  ): void {
    if (details.length === 0) throw new Error('收藏详情批次为空。');
    if (details.length !== capture.cids.length) throw new Error('收藏详情批次数量不一致。');
    if (
      !/^[a-f0-9]{64}$/.test(capture.responseSha256) ||
      capture.responseFile !== `accounts/${this.uin}/detail-raw/${capture.responseSha256}.bin`
    ) {
      throw new Error('收藏详情原始响应路径无效。');
    }
    const raw = readFileSync(join(this.root, capture.responseFile));
    if (createHash('sha256').update(raw).digest('hex') !== capture.responseSha256) {
      throw new Error('收藏详情原始响应校验失败。');
    }
    const latest: Record<string, DetailLedgerEntry> = Object.assign(
      Object.create(null),
      this.ledger.latest,
    );
    const seen = new Set<string>();
    for (const [index, detail] of details.entries()) {
      if (!detail.cid) throw new Error('收藏详情缺少 CID。');
      if (detail.cid !== capture.cids[index]) throw new Error('收藏详情批次顺序不一致。');
      if (seen.has(detail.cid)) throw new Error('收藏详情批次 ID 重复。');
      seen.add(detail.cid);
      latest[detail.cid] = {
        capturedAt: capture.capturedAt,
        responseSha256: capture.responseSha256,
        responseFile: capture.responseFile,
        responseIndex: index,
        content: encodeValue({
          ...detail.content,
          fetched: true,
          recordTime: capture.capturedAt,
        }),
      };
    }
    const next: DetailLedger = { ...this.ledger, latest, updatedAt: capture.capturedAt };
    writeFileAtomicSync(this.ledgerPath, JSON.stringify(next, null, 2));
    this.ledger = next;
  }

  saveBatch(details: readonly CollectionNetworkDetail[], rawResponse: Uint8Array): void {
    const capture = this.saveRawBatch(
      details.map((detail) => detail.cid),
      rawResponse,
    );
    this.commitBatch(details, capture);
  }

  count(): number {
    return Object.keys(this.ledger.latest).length;
  }
}
