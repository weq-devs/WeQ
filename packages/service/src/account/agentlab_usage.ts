/**
 * AgentLab token 用量记账（按账号隔离，落 JSON 到 agentlab 缓存目录）。
 *
 * 在每次 LLM 调用后追加一条记录（model / kind / 归属 persona / 场景 / token 数），
 * 供主页统计图表聚合（总量 / 各模型 / 各克隆体 / 时间趋势）。为防文件无限增长，
 * 只保留最近 MAX_RECORDS 条。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TokenUsageRecord {
  ts: number;
  model: string;
  kind: 'chat' | 'embedding' | 'vision';
  /** 归属克隆体（构建/聊天）；WeQ 助手或未知则缺省。 */
  personaId?: string;
  /** 场景：构建克隆 / 与克隆体聊天 / 助手。 */
  scope: 'build' | 'chat' | 'assistant';
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface TokenStats {
  totalTokens: number;
  totalCalls: number;
  /** 累计输入（prompt）/ 输出（completion）token，用于输入输出占比展示。 */
  promptTokens: number;
  completionTokens: number;
  byModel: Array<{ model: string; tokens: number; calls: number }>;
  byPersona: Array<{ personaId: string; tokens: number; calls: number }>;
  byScope: Array<{ scope: string; tokens: number; calls: number }>;
  /** 最近 30 天每天的 token 数（含 0 的空白天，便于折线图）。 */
  byDay: Array<{ day: string; tokens: number }>;
  /** 近 24 小时每小时的 token / 调用数（含 0 的空白小时，便于柱状图）。 */
  byHour: Array<{ hour: string; tokens: number; calls: number }>;
}

const MAX_RECORDS = 5000;
/** 没有归属克隆体的记录（如 WeQ 助手）在统计里的占位键。 */
const ASSISTANT_KEY = '__assistant__';

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class TokenUsageStore {
  private records: TokenUsageRecord[];

  constructor(private readonly filePath: string) {
    this.records = this.load();
  }

  record(entry: TokenUsageRecord): void {
    this.records.push(entry);
    if (this.records.length > MAX_RECORDS) {
      this.records = this.records.slice(this.records.length - MAX_RECORDS);
    }
    this.persist();
  }

  getStats(): TokenStats {
    const byModel = new Map<string, { tokens: number; calls: number }>();
    const byPersona = new Map<string, { tokens: number; calls: number }>();
    const byScope = new Map<string, { tokens: number; calls: number }>();
    const byDayMap = new Map<string, number>();
    const byHourMap = new Map<number, { tokens: number; calls: number }>();
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;

    for (const r of this.records) {
      totalTokens += r.totalTokens;
      promptTokens += r.promptTokens;
      completionTokens += r.completionTokens;
      bump(byModel, r.model, r.totalTokens);
      bump(byPersona, r.personaId ?? ASSISTANT_KEY, r.totalTokens);
      bump(byScope, r.scope, r.totalTokens);
      byDayMap.set(dayKey(r.ts), (byDayMap.get(dayKey(r.ts)) ?? 0) + r.totalTokens);
      bumpHour(byHourMap, Math.floor(r.ts / 3_600_000), r.totalTokens);
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
      totalCalls: this.records.length,
      promptTokens,
      completionTokens,
      byModel: toSorted(byModel).map(([model, v]) => ({ model, ...v })),
      byPersona: toSorted(byPersona).map(([personaId, v]) => ({ personaId, ...v })),
      byScope: toSorted(byScope).map(([scope, v]) => ({ scope, ...v })),
      byDay,
      byHour,
    };
  }

  private load(): TokenUsageRecord[] {
    try {
      if (!existsSync(this.filePath)) return [];
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
      return Array.isArray(parsed) ? (parsed as TokenUsageRecord[]) : [];
    } catch {
      return [];
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.records), 'utf-8');
    } catch {
      /* 记账失败不应影响主流程 */
    }
  }
}

function bump(map: Map<string, { tokens: number; calls: number }>, key: string, tokens: number): void {
  const cur = map.get(key);
  if (cur) {
    cur.tokens += tokens;
    cur.calls += 1;
  } else {
    map.set(key, { tokens, calls: 1 });
  }
}

function bumpHour(map: Map<number, { tokens: number; calls: number }>, key: number, tokens: number): void {
  const cur = map.get(key);
  if (cur) {
    cur.tokens += tokens;
    cur.calls += 1;
  } else {
    map.set(key, { tokens, calls: 1 });
  }
}

function toSorted(
  map: Map<string, { tokens: number; calls: number }>,
): Array<[string, { tokens: number; calls: number }]> {
  return [...map.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
}

export { ASSISTANT_KEY };
