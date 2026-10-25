import {
  pickMessageText,
  requestApiJson,
  type AgentLabModelRef,
  type AgentLabEndpoint,
} from '@weq/agentlab';
import type {
  IntentSenseConfig,
  IntentProfile,
  ProfileHints,
  MbtiDim,
  IntentLocalEnginePort,
} from './intent_sense';
import type { SuggestionMessage } from './intent_suggestion_prompt';
import { segmentWords } from './text_segment';
import { extractJsonBlock } from './intent_json';

const MBTI_AXIS_LABELS: Record<MbtiDim['key'], [string, string]> = {
  EI: ['外向 E', '内向 I'],
  SN: ['实感 S', '直觉 N'],
  TF: ['思考 T', '情感 F'],
  JP: ['判断 J', '感知 P'],
};

const RADAR_AXES = ['主动性', '回应速度', '情绪外露', '话题广度', '正式度'] as const;
type ProfileConfig = Pick<IntentSenseConfig, Extract<keyof IntentSenseConfig, `profile${string}`>>;

/** 独立画像流水线：只读取消息，不读取或改写逐条意图分析缓存。 */
export class InteractionProfileService {
  private profileRevision = 0;
  private profileApiCooldownUntil = 0;
  private readonly inFlight = new Map<string, Promise<IntentProfile | null>>();
  constructor(
    private readonly readConfig: () => ProfileConfig,
    private readonly loadMessages: (
      kind: 'c2c',
      peerUid: string,
      limit: number,
    ) => Promise<SuggestionMessage[]>,
    private readonly endpoint: (ref: AgentLabModelRef | null) => AgentLabEndpoint | null,
    private readonly opts: { localEngine?: IntentLocalEnginePort | null },
  ) {}
  private get config() {
    return this.readConfig();
  }
  invalidate(): void {
    this.profileRevision++;
    this.profileApiCooldownUntil = 0;
    this.inFlight.clear();
  }
  /** 引擎侧画像提示（api：一次结构化推断；local：inferMbti）。 */
  private async inferHints(peerTexts: string[]): Promise<ProfileHints | null> {
    const revision = this.profileRevision;
    if (!this.config.profileEnabled) return null;
    const mode = this.config.profileEngine;
    if (mode === 'heuristic') return null;
    if (peerTexts.length === 0) return null;
    const tryLocalHints = async (): Promise<ProfileHints | null> => {
      const port =
        this.opts.localEngine?.forModel?.(this.config.profileLocalModelId) ?? this.opts.localEngine;
      if (!port?.ready) return null;
      try {
        const dims = await port.inferMbti(peerTexts.slice(-this.config.profileSamples));
        const samples = peerTexts.slice(-this.config.profileSamples);
        const emotions: NonNullable<ProfileHints['emotions']> = [];
        for (const [index, text] of samples.entries()) {
          if (revision !== this.profileRevision) return null;
          const result = await port.analyze(text);
          if (result && Number.isFinite(result.sentiment) && Number.isFinite(result.intensity)) {
            emotions.push({
              index,
              sentiment: clamp(result.sentiment, -100, 100),
              intensity: clamp(result.intensity, 0, 100),
            });
          }
        }
        return dims || emotions.length
          ? { mbti: dims ?? undefined, emotions, engine: 'local' }
          : null;
      } catch {
        return null;
      }
    };
    if (mode === 'local') {
      return tryLocalHints();
    }
    const endpoint = this.endpoint(this.config.profileProviderRef);
    if (!endpoint || Date.now() < this.profileApiCooldownUntil) {
      return null;
    }
    const baseUrl = endpoint.baseUrl.replace(/\/+$/, '');
    const sample = peerTexts
      .slice(-this.config.profileSamples)
      .map((t, i) => `${i}. ${t}`)
      .join('\n');
    const system =
      '以下是一个人在私聊里的消息样本。基于这些消息推断其互动风格。只输出 JSON：' +
      '{"mbti":[{"key":"EI","leftPct":50},{"key":"SN","leftPct":50},{"key":"TF","leftPct":50},{"key":"JP","leftPct":50}],' +
      '"radar":[{"axis":"主动性","value":50},{"axis":"回应速度","value":50},{"axis":"情绪外露","value":50},{"axis":"话题广度","value":50},{"axis":"正式度","value":50}],' +
      `"topics":["话题词"],"emotions":[{"index":0,"sentiment":0,"intensity":50}]}（topics 最多 ${this.config.profileModelTopics} 个）。` +
      'emotions 按消息序号逐条返回，sentiment 为 -100 到 100 的情感倾向，intensity 为 0 到 100 的情绪强度。' +
      'leftPct 是左侧极（E/S/T/J）占比 0-100；radar value 0-100。不要输出其它内容。';
    try {
      const body = await requestApiJson<{
        choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
      }>({ ...endpoint, baseUrl, feature: 'intent-profile' }, '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${endpoint.apiKey}` },
        body: JSON.stringify({
          model: endpoint.model,
          temperature: this.config.profileTemperature,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: sample },
          ],
        }),
        signal: AbortSignal.timeout(this.config.profileApiTimeoutSeconds * 1000),
      });
      const parsed = extractJsonBlock(
        pickMessageText(body.choices?.[0]?.message),
      ) as ProfileHints | null;
      if (!parsed || typeof parsed !== 'object') return null;
      const hints: ProfileHints = {};
      if (Array.isArray(parsed.emotions)) {
        const byIndex = new Map<number, NonNullable<ProfileHints['emotions']>[number]>();
        for (const value of parsed.emotions) {
          if (
            !value ||
            !Number.isInteger(value.index) ||
            value.index < 0 ||
            value.index >= Math.min(peerTexts.length, this.config.profileSamples) ||
            !Number.isFinite(value.sentiment) ||
            !Number.isFinite(value.intensity)
          )
            continue;
          byIndex.set(value.index, {
            index: value.index,
            sentiment: clamp(value.sentiment, -100, 100),
            intensity: clamp(value.intensity, 0, 100),
          });
        }
        hints.emotions = [...byIndex.values()];
      }
      if (Array.isArray(parsed.mbti)) {
        hints.mbti = parsed.mbti
          .filter(
            (d): d is MbtiDim =>
              !!d &&
              typeof d === 'object' &&
              (d as MbtiDim).key in MBTI_AXIS_LABELS &&
              Number.isFinite((d as MbtiDim).leftPct),
          )
          .map((d) => ({ key: d.key, leftPct: clamp(d.leftPct, 0, 100) }));
      }
      if (Array.isArray(parsed.radar)) {
        hints.radar = parsed.radar
          .filter(
            (r): r is { axis: string; value: number } =>
              !!r &&
              typeof r === 'object' &&
              typeof (r as { axis?: unknown }).axis === 'string' &&
              typeof (r as { value?: unknown }).value === 'number' &&
              Number.isFinite(r.value),
          )
          .map((r) => ({ axis: r.axis, value: clamp(r.value, 0, 100) }));
      }
      if (Array.isArray(parsed.topics)) {
        hints.topics = parsed.topics.filter((t): t is string => typeof t === 'string' && !!t);
      }
      return { ...hints, engine: 'api' };
    } catch {
      if (revision !== this.profileRevision) return null;
      this.profileApiCooldownUntil = Date.now() + this.config.profileApiCooldownSeconds * 1000;
      return null;
    }
  }

  // ── 画像聚合 ─────────────────────────────────────────────────────────────

  /**
   * 对方互动画像（仅私聊有意义，group 会话没有「对方」概念，UI 不提供入口）。
   * 本地统计为主、引擎提示增强；无引擎结果时全部走启发式（heuristic 标记）。
   * 当前统计范围内没有可分析的对方文本时返回 null，不用默认分数生成画像。
   */
  getProfile(peerUid: string): Promise<IntentProfile | null> {
    const existing = this.inFlight.get(peerUid);
    if (existing) return existing;
    const task = this.computeProfile(peerUid).finally(() => {
      if (this.inFlight.get(peerUid) === task) this.inFlight.delete(peerUid);
    });
    this.inFlight.set(peerUid, task);
    return task;
  }

  private async computeProfile(peerUid: string): Promise<IntentProfile | null> {
    if (!this.config.profileEnabled) return null;
    const revision = this.profileRevision;
    const rows = await this.loadMessages('c2c', peerUid, this.config.profileMessages);
    if (revision !== this.profileRevision) throw new Error('互动画像设置已更改，请重新读取');
    if (!rows.some((row) => !row.mine && row.text)) return null;
    const samples = rows.filter((row) => !row.mine && row.text).slice(-this.config.profileSamples);
    const hints =
      samples.length >= this.config.profileMinSamples
        ? await this.inferHints(samples.map((row) => row.text))
        : null;
    if (revision !== this.profileRevision) throw new Error('互动画像设置已更改，请重新读取');
    const byMsgId = new Map(
      (hints?.emotions ?? []).map((result) => [samples[result.index]!.msgId, result]),
    );

    let peerMsgs = 0;
    let selfMsgs = 0;
    let peerChars = 0;
    let emojiCount = 0;
    const topicCounts = new Map<string, number>();
    const dayActivity = new Map<string, number>();
    const daySentiment = new Map<string, { sum: number; n: number }>();
    let analyzedPeer = 0;
    let sentimentWeighted = 0;
    let sentimentWeightSum = 0;
    let intensitySum = 0;
    const peerMsgLens: number[] = [];
    let initiatedByPeer = 0;
    let conversations = 0;
    let lastTime = 0;
    const GAP = this.config.profileGapMinutes * 60;

    for (const row of rows) {
      if (row.sendTime - lastTime > GAP) {
        conversations++;
        if (!row.mine) initiatedByPeer++;
      }
      lastTime = row.sendTime;

      const date = new Date(row.sendTime * 1000);
      const dateKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      if (!row.mine) {
        dayActivity.set(dateKey, (dayActivity.get(dateKey) ?? 0) + 1);
        peerMsgs++;
        if (row.text) {
          peerChars += row.text.length;
          peerMsgLens.push(row.text.length);
          for (const word of segmentWords(row.text)) {
            topicCounts.set(word, (topicCounts.get(word) ?? 0) + 1);
          }
          for (const el of row.elementsRaw) {
            if (el.kind === 'face' || el.kind === 'mface') emojiCount++;
          }
        }
      } else {
        selfMsgs++;
      }
      const r = byMsgId.get(row.msgId);
      if (r) {
        analyzedPeer++;
        // 两周半衰期量级的时间衰减：老消息对「当前好感度」影响小。
        const w = Math.exp(
          -((Date.now() / 1000 - row.sendTime) / (this.config.profileDecayDays * 86400)),
        );
        sentimentWeighted += r.sentiment * w;
        sentimentWeightSum += w;
        intensitySum += r.intensity;
        const bucket = daySentiment.get(dateKey) ?? { sum: 0, n: 0 };
        bucket.sum += r.sentiment;
        bucket.n++;
        daySentiment.set(dateKey, bucket);
      }
    }

    // 回复延迟：对方接自己话的间隔（6h 内才算「在回话」）。
    const peerReplyLags: number[] = [];
    let prevSelfTime: number | null = null;
    for (const row of rows) {
      if (row.mine) {
        prevSelfTime = row.sendTime;
      } else if (prevSelfTime !== null && row.text) {
        const lag = row.sendTime - prevSelfTime;
        if (lag > 0 && lag < 6 * 3600) peerReplyLags.push(lag);
        prevSelfTime = null;
      }
    }

    // ---- 评分 -------------------------------------------------------------
    const sentimentAvg = sentimentWeightSum > 0 ? sentimentWeighted / sentimentWeightSum : 0;
    const avgIntensity = analyzedPeer > 0 ? intensitySum / analyzedPeer : 40;
    const avgLag =
      peerReplyLags.length > 0
        ? peerReplyLags.reduce((a, b) => a + b, 0) / peerReplyLags.length
        : 1800;
    // 30s → ~100 分，2h → ~0 分（对数刻度）。
    const lagScore = clamp(100 - (Math.log2(avgLag / 30 + 1) / Math.log2(7200 / 30)) * 100, 0, 100);
    const initiationScore =
      conversations > 0 ? clamp((initiatedByPeer / conversations) * 140, 0, 100) : 50;
    const densityScore = clamp((peerMsgs / Math.max(1, dayActivity.size)) * 12, 0, 100);
    const sentimentScore = clamp((sentimentAvg + 100) / 2, 0, 100);
    const affinity =
      analyzedPeer === 0
        ? null
        : clamp(
            Math.round(
              sentimentScore * 0.35 +
                lagScore * 0.2 +
                initiationScore * 0.2 +
                densityScore * 0.15 +
                Math.min(100, avgIntensity) * 0.1,
            ),
            0,
            100,
          );
    const tier =
      affinity === null
        ? null
        : affinity >= 80
          ? 4
          : affinity >= 60
            ? 3
            : affinity >= 40
              ? 2
              : affinity >= 20
                ? 1
                : 0;

    // 走势：活跃日的当日情绪均分（7 成）+ 当日消息量（3 成）。
    const trend = [...daySentiment.entries()]
      .map(([date, b]) => ({
        date,
        score: clamp(
          Math.round(
            ((b.sum / b.n + 100) / 2) * 0.7 +
              Math.min(100, (dayActivity.get(date) ?? 0) * 10) * 0.3,
          ),
          0,
          100,
        ),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(-this.config.profileTrendDays);

    // 启发式 MBTI / 雷达（引擎提示可用时覆盖）。
    const avgLen = peerMsgLens.length > 0 ? peerChars / peerMsgLens.length : 0;
    const lenVar = peerMsgLens.length > 1 ? variance(peerMsgLens) : 0;
    const lagVar = peerReplyLags.length > 1 ? variance(peerReplyLags) : 0;
    const emojiRatio = peerMsgs > 0 ? emojiCount / peerMsgs : 0;
    const uniqueWords = topicCounts.size;
    const heuristicMbti: MbtiDim[] = [
      {
        key: 'EI',
        leftPct: clamp(
          Math.round(50 + (initiationScore - 50) * 0.4 + (emojiRatio - 0.15) * 80),
          0,
          100,
        ),
      },
      { key: 'SN', leftPct: clamp(Math.round(62 - Math.min(40, uniqueWords / 12)), 0, 100) },
      {
        key: 'TF',
        leftPct: clamp(Math.round(55 - (avgIntensity - 40) * 0.35 - emojiRatio * 60), 0, 100),
      },
      {
        key: 'JP',
        leftPct: clamp(
          Math.round(50 - normalizeVar(lagVar, avgLag) * 30 - normalizeVar(lenVar, avgLen) * 20),
          0,
          100,
        ),
      },
    ];
    const heuristicRadar: Array<{ axis: string; value: number }> = [
      { axis: RADAR_AXES[0] as string, value: Math.round(initiationScore) },
      { axis: RADAR_AXES[1] as string, value: Math.round(lagScore) },
      {
        axis: RADAR_AXES[2] as string,
        value: Math.round(clamp(avgIntensity * 0.7 + emojiRatio * 150, 0, 100)),
      },
      { axis: RADAR_AXES[3] as string, value: Math.round(clamp(uniqueWords * 2.2, 0, 100)) },
      { axis: RADAR_AXES[4] as string, value: Math.round(clamp(avgLen * 2.4, 0, 100)) },
    ];

    let mbtiDims = heuristicMbti;
    let radar =
      analyzedPeer > 0 ? heuristicRadar : heuristicRadar.filter((item) => item.axis !== '情绪外露');
    let engine: IntentProfile['engine'] = 'heuristic';
    let hintTopics: string[] | null = null;
    if (hints) {
      engine = hints.engine ?? 'heuristic';
      if (hints.mbti && hints.mbti.length === 4) mbtiDims = hints.mbti;
      if (hints.radar && hints.radar.length >= 3) radar = mergeRadar(radar, hints.radar);
      hintTopics = hints.topics ?? null;
    }

    const topics = (
      hintTopics
        ? hintTopics
            .slice(0, this.config.profileTopicLimit)
            .map((t) => ({ topic: t, count: topicCounts.get(t) ?? 0 }))
        : [...topicCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.config.profileTopicLimit)
            .map(([topic, count]) => ({ topic, count }))
    ).filter((t) => t.count > 0 || hintTopics !== null);

    const letters = [...mbtiDims]
      .sort((a, b) => orderKey(a.key) - orderKey(b.key))
      .map((d) => (d.leftPct >= 50 ? d.key[0] : d.key[1]))
      .join('');

    if (revision !== this.profileRevision) throw new Error('互动画像设置已更改，请重新读取');
    return {
      affinity,
      tier,
      trend,
      mbti: { letters, dims: mbtiDims, heuristic: hints?.mbti?.length !== 4 },
      radar,
      topics,
      sampled: peerMsgs + selfMsgs,
      analyzedSamples: analyzedPeer,
      engine,
      computedAt: Date.now(),
    };
  }
}

function variance(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

/** 变异系数 0..1（离散程度归一，供 J/P 的「节奏稳定性」打分）。 */
function normalizeVar(vari: number, mean: number): number {
  if (mean <= 0) return 0.5;
  return clamp(Math.sqrt(vari) / mean / 2, 0, 1);
}

function orderKey(key: MbtiDim['key']): number {
  return ['EI', 'SN', 'TF', 'JP'].indexOf(key);
}

/** 引擎雷达值与启发式雷达值折中（引擎 0.65 / 启发式 0.35，缺轴补启发式）。 */
function mergeRadar(
  heuristic: Array<{ axis: string; value: number }>,
  hints: Array<{ axis: string; value: number }>,
): Array<{ axis: string; value: number }> {
  const byAxis = new Map(hints.map((r) => [r.axis, r.value]));
  return heuristic.map((h) => {
    const v = byAxis.get(h.axis);
    return v === undefined ? h : { axis: h.axis, value: Math.round(h.value * 0.35 + v * 0.65) };
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
