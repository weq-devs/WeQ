/**
 * 群聊「要不要回」意愿闸（借鉴 MaiBot reply_necessity，纯启发式、不调 LLM）。
 *
 * 这才是对「私聊必回」的颠覆：群里一条消息进来，每个克隆体各自过一遍这个闸，
 * 过阈值才生成回复——被 @ 必回，被点名/被提问/聊到感兴趣的会更想接话，
 * 而最近自己已经说了很多（存在感高）、刚回过没多久（冷却）、或对这个人没什么好感/
 * 正闹别扭（关系差）时，就更可能选择不吭声。静默是合法结果。
 *
 * 输出 effort（上心程度）再决定回得多快 / 分几条。私聊路径仍走 willing.ts（1:1 测试
 * 场景本就该必回），这个闸只服务群聊扇出。
 */

const QUESTION_RE = /[?？]|吗[?？。!！]?$|呢[?？。!！]?$|怎么|为什么|为啥|咋|多少|哪|几点/;
const REQUEST_RE = /帮我|帮忙|能不能|可不可以|可以吗|行不行|给我|教我|怎么弄|怎么搞/;
const OPINION_RE = /你觉得|你认为|你说|你看|怎么样|如何|好不好|对吧/;
const SHORT_REACTIONS = new Set(['嗯', '哦', '噢', '额', '啊', '在', '？', '?', '。', '哈', '哈哈', '嗯嗯', '好', '好的', 'ok', 'OK']);

/** 群聊回复阈值：低于此分就不接话。基准刻意压低，让「不必回」成为常态。 */
export const GROUP_REPLY_THRESHOLD = 0.5;

export interface ReplyGateInput {
  /** 触发消息文本。 */
  text: string;
  /** 这个克隆体的名字（用于检测「被点名」）。 */
  personaName: string;
  /** 别名（可选）。 */
  aliases?: string[];
  /** 是否被 @ 到（硬触发，必回）。 */
  mentioned?: boolean;
  /** 触发者是不是「我」（主人）。 */
  fromOwner?: boolean;
  /** 兴趣关键词（话题 / 口头禅 / 高频词），命中会更想接话。 */
  interestTerms?: string[];
  /** 关系态（M4 注入；缺省按中性处理）。 */
  relation?: { affinity: number; mood: number; familiarity: number } | null;
  /** 最近若干条里「自己」的占比 0~1（存在感惩罚）。 */
  selfShareRecent?: number;
  /** 距自己上次发言的毫秒数（冷却）。 */
  msSinceOwnLastReply?: number;
  /** 用户设置的总体意愿偏置（-0.4~+0.4，直接加到分数上）。 */
  levelBias?: number;
  /** 被 @ 是否必回（默认 true）。false 时被 @ 只是强加分，仍要过阈值。 */
  mustReplyOnMention?: boolean;
}

/** 把 0~100 的意愿档位换成 -0.4~+0.4 的分数偏置（50=中性）。 */
export function willingLevelBias(level: number | undefined): number {
  if (level === undefined) return 0;
  const clamped = Math.max(0, Math.min(100, level));
  return ((clamped - 50) / 50) * 0.4;
}

export interface ReplyDecision {
  shouldReply: boolean;
  /** 0~1 意愿分。 */
  score: number;
  /** 决策主因（调试 / 展示用）。 */
  reason: string;
  /** 0~1 上心程度：越高回得越快、可以多分几条。 */
  effort: number;
  /** 建议首条回复前延迟（ms）：越想回越快开口。 */
  replyDelayMs: number;
  /** 建议最多分几条。 */
  maxSegments: number;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function nameMentioned(text: string, name: string, aliases?: string[]): boolean {
  const hay = text.toLowerCase();
  const names = [name, ...(aliases ?? [])].map((n) => n.trim().toLowerCase()).filter((n) => n.length >= 2);
  return names.some((n) => hay.includes(n));
}

function toDecision(score: number, reason: string): ReplyDecision {
  const s = clamp01(score);
  const shouldReply = s >= GROUP_REPLY_THRESHOLD;
  // 越想回越快开口（300ms～2300ms），加一点随机抖动让多人不同步开口。
  const jitter = Math.random() * 400;
  const replyDelayMs = Math.round(300 + (1 - s) * 2000 + jitter);
  const maxSegments = s < 0.4 ? 2 : s < 0.7 ? 3 : 4;
  return { shouldReply, score: s, reason, effort: s, replyDelayMs, maxSegments };
}

/** 评估某个克隆体对这条群消息的回复意愿。 */
export function scoreReplyGate(inp: ReplyGateInput): ReplyDecision {
  const text = inp.text.trim();

  // 被 @ 且设置为必回 → 硬触发；否则被 @ 只是强加分，仍要过阈值（见下）。
  if (inp.mentioned && inp.mustReplyOnMention !== false) {
    return { shouldReply: true, score: 1, reason: '被@必回', effort: 0.85, replyDelayMs: Math.round(300 + Math.random() * 500), maxSegments: 4 };
  }

  // 群聊基准低：默认可以不接话。
  let score = 0.2;
  let reason = '默默围观';
  // 被 @ 但用户设了「@不必回」：给个强 bump，但仍要过阈值。
  if (inp.mentioned) {
    score += 0.5;
    reason = '被@了';
  }
  // 用户设置的总体意愿偏置。
  score += inp.levelBias ?? 0;
  const bump = (delta: number, why: string): void => {
    score += delta;
    if (delta > 0) reason = why;
  };

  if (nameMentioned(text, inp.personaName, inp.aliases)) bump(0.45, '被点名');
  if (inp.fromOwner) score += 0.12;

  if (QUESTION_RE.test(text)) bump(0.18, '被提问');
  if (REQUEST_RE.test(text)) bump(0.15, '被请求');
  if (OPINION_RE.test(text)) bump(0.12, '被征询');

  const terms = (inp.interestTerms ?? []).filter((t) => t && t.length >= 2);
  if (terms.length > 0 && terms.some((t) => text.includes(t))) bump(0.16, '聊到感兴趣的');

  if (text.length >= 40) score += 0.05;
  if (SHORT_REACTIONS.has(text) || text.length <= 2) score -= 0.15;

  // 关系：亲近更想回，情绪差就晾着（M4 注入 relation 后才有明显作用）。
  const rel = inp.relation;
  if (rel) {
    score += ((rel.affinity - 50) / 100) * 0.3; // affinity 100→+0.15，0→-0.15
    score += (rel.mood / 50) * 0.15; // mood +50→+0.15，-50→-0.15
  }

  // 存在感惩罚：最近自己说太多 → 收着点，别一直刷屏。
  if (inp.selfShareRecent !== undefined && inp.selfShareRecent > 0.5) score -= 0.15;
  // 冷却：刚说过没多久 → 别抢话。
  if (inp.msSinceOwnLastReply !== undefined && inp.msSinceOwnLastReply < 15000) score -= 0.2;

  // 一点随机，让群聊不那么机械（有时想接、有时懒得接）。
  score += (Math.random() - 0.5) * 0.12;

  return toDecision(score, reason);
}
