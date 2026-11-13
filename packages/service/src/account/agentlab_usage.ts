import { calendarParts, calendarStart, formatDate } from '@weq/time';
/**
 * API 用量账本：账号请求与应用全局请求独立落盘，读取时按时间范围合并。
 *
 * 同一实际请求按 requestId 更新状态与用量，保留服务商快照和功能归属。
 * 每份账本只保留最近 MAX_RECORDS 条；统计显式返回保留范围，不冒充历史累计。
 */

import { JsonStore } from '../common/json_store';
import type { AgentLabUsage } from '@weq/agentlab';
import { resolve } from 'node:path';

export interface TokenUsageRecord extends AgentLabUsage {
  ts: number;
  /** 归属克隆体（构建/聊天）；WeQ 助手或未知则缺省。 */
  personaId?: string;
  /** 功能场景；细分用途由 feature 保存。 */
  scope: string;
}

export type ApiUsagePeriod = '24h' | '7d' | '30d' | 'retained';

interface UsageLedger {
  source: 'account' | 'global';
  retainedCalls: number;
  limit: number;
  atCapacity: boolean;
  firstRecordAt: number | null;
  lastRecordAt: number | null;
}

export interface TokenStats {
  totalTokens: number;
  totalCalls: number;
  globalCalls: number;
  accountCalls: number;
  period: ApiUsagePeriod;
  range: { since: number | null; until: number };
  ledgers: UsageLedger[];
  knownCalls: number;
  unknownCalls: number;
  promptUnknownCalls: number;
  completionUnknownCalls: number;
  failedCalls: number;
  cancelledCalls: number;
  pendingCalls: number;
  interruptedCalls: number;
  /** 累计输入（prompt）/ 输出（completion）token，用于输入输出占比展示。 */
  promptTokens: number;
  completionTokens: number;
  byModel: Array<
    UsageBucket & {
      key: string;
      model: string;
      providerId: string | null;
      providerName: string | null;
      providerKind: 'model' | 'tts';
    }
  >;
  byPersona: Array<{ personaId: string; tokens: number; calls: number; unknownCalls: number }>;
  byScope: Array<{ scope: string; tokens: number; calls: number; unknownCalls: number }>;
  byFeature: Array<{ feature: string; tokens: number; calls: number; unknownCalls: number }>;
  /** 最近 7／30 天的已知 token、请求与未知次数，包含北京时间的空白天。 */
  byDay: Array<UsageBucket & { day: string }>;
  /** 最近 24 个小时桶（含当前小时），空白小时补零。 */
  byHour: Array<UsageBucket & { hour: string }>;
}

const MAX_RECORDS = 5000;
// 同一进程切回账号时复用在途请求持有的账本，弱引用避免常驻所有历史账号。
const stores = new Map<string, WeakRef<JsonStore<TokenUsageRecord[]>>>();
/** 没有归属克隆体的记录（如 WeQ 助手）在统计里的占位键。 */
const ASSISTANT_KEY = '__assistant__';

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeRecord(raw: unknown): TokenUsageRecord | null {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('model' in raw) ||
    typeof raw.model !== 'string' ||
    !('scope' in raw) ||
    typeof raw.scope !== 'string' ||
    !('ts' in raw) ||
    typeof raw.ts !== 'number' ||
    !Number.isFinite(raw.ts) ||
    !('kind' in raw) ||
    !['chat', 'embedding', 'vision', 'speech'].includes(String(raw.kind))
  )
    return null;
  if ('source' in raw && raw.source === 'local') return null;
  const value = raw as TokenUsageRecord;
  return {
    ...value,
    promptTokens: tokenCount(value.promptTokens),
    completionTokens: tokenCount(value.completionTokens),
    totalTokens: tokenCount(value.totalTokens),
    status:
      value.status === 'pending' ||
      value.status === 'failed' ||
      value.status === 'cancelled' ||
      value.status === 'interrupted'
        ? value.status
        : 'success',
  };
}

export class TokenUsageStore {
  private readonly store: JsonStore<TokenUsageRecord[]>;

  constructor(filePath: string) {
    const key = resolve(filePath);
    for (const [path, ref] of stores) if (!ref.deref()) stores.delete(path);
    const existing = stores.get(key)?.deref();
    if (existing) {
      this.store = existing;
      return;
    }
    this.store = new JsonStore(key, () => [], {
      normalize: (raw) => {
        if (!Array.isArray(raw)) throw new Error('API 用量记录格式无效');
        return raw
          .map(normalizeRecord)
          .filter((r): r is TokenUsageRecord => r !== null)
          .slice(-MAX_RECORDS)
          .map((r) => (r.status === 'pending' ? { ...r, status: 'interrupted' as const } : r));
      },
    });
    stores.set(key, new WeakRef(this.store));
  }

  private get records(): TokenUsageRecord[] {
    return this.store.data;
  }

  private set records(next: TokenUsageRecord[]) {
    this.store.data = next;
  }

  record(entry: TokenUsageRecord): void {
    const value = normalizeRecord(entry);
    if (!value) return;
    const previous = value.requestId
      ? this.records.findIndex((r) => r.requestId === value.requestId)
      : -1;
    if (previous >= 0) {
      const old = this.records[previous]!;
      this.records[previous] = {
        ...old,
        ...value,
        ts: old.ts,
        status: old.status !== 'pending' && value.status === 'pending' ? old.status : value.status,
        promptTokens: value.promptTokens ?? old.promptTokens,
        completionTokens: value.completionTokens ?? old.completionTokens,
        totalTokens: value.totalTokens ?? old.totalTokens,
      };
    } else this.records.push(value);
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(this.records.length - MAX_RECORDS);
    }
    this.persist();
  }

  getStats(
    global?: TokenUsageStore,
    period: ApiUsagePeriod = 'retained',
    now = Date.now(),
  ): TokenStats {
    try {
      this.store.assertReadable();
      global?.store.assertReadable();
    } catch {
      throw new Error('API 用量记录读取失败，原始记录已保留');
    }
    const globalRecords = global && global.store !== this.store ? global.records : [];
    const nowHour = Math.floor(now / 3_600_000);
    const date = calendarParts(now)!;
    const todayStart = calendarStart(date.year, date.month, date.day);
    const days = period === '7d' ? 7 : 30;
    const since =
      period === 'retained'
        ? null
        : period === '24h'
          ? (nowHour - 23) * 3_600_000
          : todayStart - (days - 1) * 86_400_000;
    const inRange = (r: TokenUsageRecord): boolean =>
      (since === null || r.ts >= since) && r.ts <= now;
    const records = [...this.records, ...globalRecords].filter(inRange);
    const seen = new Map<string, TokenUsageRecord>();
    const unique = records.filter((r) => !r.requestId);
    for (const record of records) if (record.requestId) seen.set(record.requestId, record);
    unique.push(...seen.values());
    const globalIds = new Set(globalRecords.filter(inRange));
    const globalCalls = unique.filter((r) => globalIds.has(r)).length;
    const ledgers = [ledger('account', this.records)];
    if (global && global.store !== this.store) ledgers.push(ledger('global', globalRecords));
    const byModel = new Map<string, UsageBucket>();
    const models = new Map<string, Omit<TokenStats['byModel'][number], keyof UsageBucket>>();
    const byPersona = new Map<string, UsageBucket>();
    const byScope = new Map<string, UsageBucket>();
    const byFeature = new Map<string, UsageBucket>();
    const byDayMap = new Map<string, UsageBucket>();
    const byHourMap = new Map<string, UsageBucket>();
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let unknownCalls = 0;
    let promptUnknownCalls = 0;
    let completionUnknownCalls = 0;
    let failedCalls = 0;
    let cancelledCalls = 0;
    let pendingCalls = 0;
    let interruptedCalls = 0;

    for (const r of unique) {
      const tokens = r.totalTokens ?? 0;
      const unknown = r.totalTokens === null;
      totalTokens += tokens;
      promptTokens += r.promptTokens ?? 0;
      completionTokens += r.completionTokens ?? 0;
      unknownCalls += Number(unknown);
      promptUnknownCalls += Number(r.promptTokens === null);
      completionUnknownCalls += Number(r.completionTokens === null);
      failedCalls += Number(r.status === 'failed');
      cancelledCalls += Number(r.status === 'cancelled');
      pendingCalls += Number(r.status === 'pending');
      interruptedCalls += Number(r.status === 'interrupted');
      const providerId =
        typeof r.providerId === 'string' && r.providerId.trim() ? r.providerId : null;
      const providerKind = r.kind === 'speech' ? 'tts' : 'model';
      const modelKey = JSON.stringify([providerKind, providerId, r.model]);
      bump(byModel, modelKey, tokens, unknown);
      models.set(modelKey, {
        key: modelKey,
        model: r.model,
        providerId,
        providerKind,
        providerName: providerId && typeof r.providerName === 'string' ? r.providerName : null,
      });
      bump(
        byPersona,
        r.personaId ?? (r.scope === 'assistant' ? ASSISTANT_KEY : '__unassigned__'),
        tokens,
        unknown,
      );
      bump(byScope, r.scope, tokens, unknown);
      bump(byFeature, r.feature ?? r.scope, tokens, unknown);
      bump(byDayMap, formatDate(r.ts), tokens, unknown);
      bump(byHourMap, String(Math.floor(r.ts / 3_600_000)), tokens, unknown);
    }

    const byDay: TokenStats['byDay'] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const day = formatDate(todayStart - i * 86_400_000);
      byDay.push({ day, ...(byDayMap.get(day) ?? emptyBucket()) });
    }

    // 小时桶使用实际时间戳归组，标签统一北京时间。
    const byHour: TokenStats['byHour'] = [];
    for (let i = 23; i >= 0; i -= 1) {
      const h = nowHour - i;
      const label = `${String(calendarParts(h * 3_600_000)!.hour).padStart(2, '0')}:00`;
      byHour.push({ hour: label, ...(byHourMap.get(String(h)) ?? emptyBucket()) });
    }

    return {
      totalTokens,
      totalCalls: unique.length,
      globalCalls,
      accountCalls: unique.length - globalCalls,
      period,
      range: { since, until: now },
      ledgers,
      knownCalls: unique.length - unknownCalls,
      unknownCalls,
      promptUnknownCalls,
      completionUnknownCalls,
      failedCalls,
      cancelledCalls,
      pendingCalls,
      interruptedCalls,
      promptTokens,
      completionTokens,
      byModel: toSorted(byModel).map(([key, v]) => ({ ...models.get(key)!, ...v })),
      byPersona: toSorted(byPersona).map(([personaId, v]) => ({ personaId, ...v })),
      byScope: toSorted(byScope).map(([scope, v]) => ({ scope, ...v })),
      byFeature: toSorted(byFeature).map(([feature, v]) => ({ feature, ...v })),
      byDay,
      byHour,
    };
  }

  private persist(): void {
    this.store.save();
  }
}

interface UsageBucket {
  tokens: number;
  calls: number;
  unknownCalls: number;
}

function bump(map: Map<string, UsageBucket>, key: string, tokens: number, unknown: boolean): void {
  const cur = map.get(key);
  if (cur) {
    cur.tokens += tokens;
    cur.calls += 1;
    cur.unknownCalls += Number(unknown);
  } else {
    map.set(key, { tokens, calls: 1, unknownCalls: Number(unknown) });
  }
}

function emptyBucket(): UsageBucket {
  return { tokens: 0, calls: 0, unknownCalls: 0 };
}

function ledger(source: UsageLedger['source'], records: TokenUsageRecord[]): UsageLedger {
  let firstRecordAt: number | null = null;
  let lastRecordAt: number | null = null;
  for (const record of records) {
    firstRecordAt = firstRecordAt === null ? record.ts : Math.min(firstRecordAt, record.ts);
    lastRecordAt = lastRecordAt === null ? record.ts : Math.max(lastRecordAt, record.ts);
  }
  return {
    source,
    retainedCalls: records.length,
    limit: MAX_RECORDS,
    atCapacity: records.length >= MAX_RECORDS,
    firstRecordAt,
    lastRecordAt,
  };
}

function toSorted(map: Map<string, UsageBucket>): Array<[string, UsageBucket]> {
  return [...map.entries()].sort(
    (a, b) => b[1].tokens - a[1].tokens || b[1].calls - a[1].calls || a[0].localeCompare(b[0]),
  );
}

export { ASSISTANT_KEY };
