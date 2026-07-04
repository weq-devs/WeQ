/**
 * bot 运行统计（JSON 落盘，重启保持）。
 *
 * 两条数据来源：
 *   ① token 用量：实现 UsageSink，AgentRuntime 每次调用 LLM 会喂 promptTokens/completionTokens。
 *   ② 收发消息：orchestrator 在收/发/生成处打点（onMessageIn/onMessageOut/onReplyGenerated）。
 *
 * 聚合维度：总量 + 按模型 + 按天（YYYY-MM-DD，本地时区），供 WebUI 统计页展示。
 * 落盘到产物 data/stats.json；startedAt 记进程本次启动时间（运行时长），totals 跨重启累加。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageSink } from '@weq/agentlab';

/** 单日聚合桶。 */
export interface StatsDayBucket {
  /** 本地日期 YYYY-MM-DD */
  date: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  messagesIn: number;
  messagesOut: number;
}

/** 按模型聚合。 */
export interface StatsModelBucket {
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** 单小时聚合桶（近 24 小时折线用）。 */
export interface StatsHourBucket {
  /** 展示用标签 HH:00（snapshot 时填）。 */
  hour: string;
  tokens: number;
  calls: number;
}

interface StatsData {
  /** 首次启动（历史累计起点）。 */
  firstStartedAt: number;
  totals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    llmCalls: number;
    messagesIn: number;
    messagesOut: number;
    repliesGenerated: number;
  };
  byModel: Record<string, StatsModelBucket>;
  byDay: Record<string, StatsDayBucket>;
  /** key = YYYY-MM-DD-HH（本地时区）；只保留近 ~48h，snapshot 取近 24h。 */
  byHour: Record<string, { tokens: number; calls: number }>;
}

/** WebUI /api/stats 的返回快照。 */
export interface StatsSnapshot {
  firstStartedAt: number;
  /** 本次进程启动时间（运行时长 = now - startedAt）。 */
  startedAt: number;
  now: number;
  totals: StatsData['totals'];
  byModel: StatsModelBucket[];
  /** 最近 N 天，最早→最晚。 */
  byDay: StatsDayBucket[];
  /** 最近 24 小时，最早→最晚。 */
  byHour: StatsHourBucket[];
}

function emptyData(now: number): StatsData {
  return {
    firstStartedAt: now,
    totals: {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      llmCalls: 0,
      messagesIn: 0,
      messagesOut: 0,
      repliesGenerated: 0,
    },
    byModel: {},
    byDay: {},
    byHour: {},
  };
}

/** 本地时区 YYYY-MM-DD。 */
function dayKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 本地时区 YYYY-MM-DD-HH（小时聚合键）。 */
function hourKey(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  return `${dayKey(ts)}-${h}`;
}

/** 裁掉早于 48 小时的小时桶（近 24h 展示够用，留一倍余量防时区/边界丢点）。 */
function pruneHours(
  hours: Record<string, { tokens: number; calls: number }>,
  now: number,
): Record<string, { tokens: number; calls: number }> {
  const keep = new Set<string>();
  for (let i = 0; i < 48; i++) keep.add(hourKey(now - i * 3600_000));
  const out: Record<string, { tokens: number; calls: number }> = {};
  for (const [k, v] of Object.entries(hours)) if (keep.has(k)) out[k] = v;
  return out;
}

export class StatsStore implements UsageSink {
  private readonly data: StatsData;
  private readonly startedAt: number;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly filePath: string,
    now: number = Date.now(),
  ) {
    this.startedAt = now;
    this.data = this.load(now);
  }

  private load(now: number): StatsData {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as Partial<StatsData>;
        const base = emptyData(now);
        return {
          firstStartedAt: parsed.firstStartedAt ?? now,
          totals: { ...base.totals, ...parsed.totals },
          byModel: parsed.byModel ?? {},
          byDay: parsed.byDay ?? {},
          byHour: pruneHours(parsed.byHour ?? {}, now),
        };
      }
    } catch {
      /* 损坏则重来，不阻断 bot */
    }
    return emptyData(now);
  }

  /** 合并写盘（200ms 防抖，避免高频消息把磁盘打爆）。 */
  private persist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
        writeFileSync(this.filePath, JSON.stringify(this.data), 'utf-8');
      } catch {
        /* 落盘失败不阻断聊天 */
      }
    }, 200);
    this.saveTimer.unref?.();
  }

  private dayBucket(ts: number): StatsDayBucket {
    const key = dayKey(ts);
    let bucket = this.data.byDay[key];
    if (!bucket) {
      bucket = { date: key, promptTokens: 0, completionTokens: 0, totalTokens: 0, messagesIn: 0, messagesOut: 0 };
      this.data.byDay[key] = bucket;
    }
    return bucket;
  }

  /** UsageSink：AgentRuntime 每次 LLM 调用后回调。 */
  record(entry: {
    ts: number;
    model: string;
    kind: 'chat' | 'embedding' | 'vision';
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }): void {
    const t = this.data.totals;
    t.promptTokens += entry.promptTokens;
    t.completionTokens += entry.completionTokens;
    t.totalTokens += entry.totalTokens;
    t.llmCalls += 1;

    const model = entry.model || '(unknown)';
    let mb = this.data.byModel[model];
    if (!mb) {
      mb = { model, calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      this.data.byModel[model] = mb;
    }
    mb.calls += 1;
    mb.promptTokens += entry.promptTokens;
    mb.completionTokens += entry.completionTokens;
    mb.totalTokens += entry.totalTokens;

    const day = this.dayBucket(entry.ts);
    day.promptTokens += entry.promptTokens;
    day.completionTokens += entry.completionTokens;
    day.totalTokens += entry.totalTokens;

    const hk = hourKey(entry.ts);
    const hb = this.data.byHour[hk] ?? { tokens: 0, calls: 0 };
    hb.tokens += entry.totalTokens;
    hb.calls += 1;
    this.data.byHour[hk] = hb;
    // 长跑进程每小时新增一个键，超过阈值就裁到近 48h，防无界增长。
    if (Object.keys(this.data.byHour).length > 60) {
      this.data.byHour = pruneHours(this.data.byHour, entry.ts);
    }

    this.persist();
  }

  onMessageIn(ts: number = Date.now()): void {
    this.data.totals.messagesIn += 1;
    this.dayBucket(ts).messagesIn += 1;
    this.persist();
  }

  onMessageOut(ts: number = Date.now()): void {
    this.data.totals.messagesOut += 1;
    this.dayBucket(ts).messagesOut += 1;
    this.persist();
  }

  onReplyGenerated(): void {
    this.data.totals.repliesGenerated += 1;
    this.persist();
  }

  /** 供 WebUI 读取的快照（byDay 取最近 days 天，补齐空档）。 */
  snapshot(days = 14, now: number = Date.now()): StatsSnapshot {
    const byDay: StatsDayBucket[] = [];
    const dayMs = 24 * 60 * 60 * 1000;
    for (let i = days - 1; i >= 0; i--) {
      const key = dayKey(now - i * dayMs);
      byDay.push(
        this.data.byDay[key] ?? {
          date: key,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          messagesIn: 0,
          messagesOut: 0,
        },
      );
    }
    // 近 24 小时（含当前小时），最早→最晚，补齐空档，label 用本地 HH:00。
    const byHour: StatsHourBucket[] = [];
    for (let i = 23; i >= 0; i--) {
      const ts = now - i * 3600_000;
      const key = hourKey(ts);
      const b = this.data.byHour[key];
      byHour.push({
        hour: `${String(new Date(ts).getHours()).padStart(2, '0')}:00`,
        tokens: b?.tokens ?? 0,
        calls: b?.calls ?? 0,
      });
    }

    const byModel = Object.values(this.data.byModel).sort((a, b) => b.totalTokens - a.totalTokens);
    return {
      firstStartedAt: this.data.firstStartedAt,
      startedAt: this.startedAt,
      now,
      totals: { ...this.data.totals },
      byModel,
      byDay,
      byHour,
    };
  }
}
