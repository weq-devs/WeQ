/**
 * AgentLab token 用量记账（按账号隔离，落 JSON 到 agentlab 缓存目录）。
 *
 * 在每次 LLM 调用后追加一条记录（model / kind / 归属 persona / 场景 / token 数），
 * 供主页统计图表聚合（总量 / 各模型 / 各克隆体 / 时间趋势）。为防文件无限增长，
 * 只保留最近 MAX_RECORDS 条。
 */

import { JsonStore } from '../common/json_store';
import type { AgentLabUsage } from '@weq/agentlab';
import { resolve } from 'node:path';

export interface TokenUsageRecord extends AgentLabUsage {
  ts: number;
  /** 归属克隆体（构建/聊天）；WeQ 助手或未知则缺省。 */
  personaId?: string;
  /** 场景：构建克隆 / 与克隆体聊天 / 助手。 */
  scope: string;
}

export interface TokenStats {
  totalTokens: number;
  totalCalls: number;
  globalCalls: number;
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
  byModel: Array<{ model: string; tokens: number; calls: number; unknownCalls: number }>;
  byPersona: Array<{ personaId: string; tokens: number; calls: number; unknownCalls: number }>;
  byScope: Array<{ scope: string; tokens: number; calls: number; unknownCalls: number }>;
  byFeature: Array<{ feature: string; tokens: number; calls: number; unknownCalls: number }>;
  /** 最近 30 天每天的 token 数（含 0 的空白天，便于折线图）。 */
  byDay: Array<{ day: string; tokens: number }>;
  /** 近 24 小时每小时的 token / 调用数（含 0 的空白小时，便于柱状图）。 */
  byHour: Array<{ hour: string; tokens: number; calls: number }>;
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

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
      normalize: (raw) =>
        Array.isArray(raw)
          ? raw
              .map(normalizeRecord)
              .filter((r): r is TokenUsageRecord => r !== null)
              .slice(-MAX_RECORDS)
              .map((r) => (r.status === 'pending' ? { ...r, status: 'interrupted' as const } : r))
          : [],
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

  getStats(global?: TokenUsageStore): TokenStats {
    const globalRecords = global && global.store !== this.store ? global.records : [];
    const records = [...this.records, ...globalRecords];
    const seen = new Map<string, TokenUsageRecord>();
    const unique = records.filter((r) => !r.requestId);
    for (const record of records) if (record.requestId) seen.set(record.requestId, record);
    unique.push(...seen.values());
    const byModel = new Map<string, UsageBucket>();
    const byPersona = new Map<string, UsageBucket>();
    const byScope = new Map<string, UsageBucket>();
    const byFeature = new Map<string, UsageBucket>();
    const byDayMap = new Map<string, number>();
    const byHourMap = new Map<number, { tokens: number; calls: number }>();
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
      bump(byModel, r.model, tokens, unknown);
      bump(
        byPersona,
        r.personaId ?? (r.scope === 'assistant' ? ASSISTANT_KEY : '__unassigned__'),
        tokens,
        unknown,
      );
      bump(byScope, r.scope, tokens, unknown);
      bump(byFeature, r.feature ?? r.scope, tokens, unknown);
      byDayMap.set(dayKey(r.ts), (byDayMap.get(dayKey(r.ts)) ?? 0) + tokens);
      bumpHour(byHourMap, Math.floor(r.ts / 3_600_000), tokens);
    }

    // 最近 30 天（含空白天）。注意：不能用 Date.now()——这里在普通 service 上下文，允许。
    const byDay: Array<{ day: string; tokens: number }> = [];
    const today = Date.now();
    for (let i = 29; i >= 0; i -= 1) {
      const day = dayKey(today - i * 86_400_000);
      byDay.push({ day, tokens: byDayMap.get(day) ?? 0 });
    }

    // 近 24 小时（含空白小时），label 为当地「HH:00」。
    const byHour: Array<{ hour: string; tokens: number; calls: number }> = [];
    const nowHour = Math.floor(today / 3_600_000);
    for (let i = 23; i >= 0; i -= 1) {
      const h = nowHour - i;
      const label = `${String(new Date(h * 3_600_000).getHours()).padStart(2, '0')}:00`;
      const v = byHourMap.get(h);
      byHour.push({ hour: label, tokens: v?.tokens ?? 0, calls: v?.calls ?? 0 });
    }

    return {
      totalTokens,
      totalCalls: unique.length,
      globalCalls: globalRecords.length,
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
      byModel: toSorted(byModel).map(([model, v]) => ({ model, ...v })),
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

function bumpHour(
  map: Map<number, { tokens: number; calls: number }>,
  key: number,
  tokens: number,
): void {
  const cur = map.get(key);
  if (cur) {
    cur.tokens += tokens;
    cur.calls += 1;
  } else {
    map.set(key, { tokens, calls: 1 });
  }
}

function toSorted(map: Map<string, UsageBucket>): Array<[string, UsageBucket]> {
  return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
}

export { ASSISTANT_KEY };
