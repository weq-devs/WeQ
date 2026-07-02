/**
 * 关系态的纯逻辑（初值 / clamp / 增量）。存储无关——JSON 与 SQLite 后端共用，
 * 引擎与打分器也用它算「更新后的关系态」。M4 的互动打分产出 delta，喂给
 * applyRelationDelta 即可。
 *
 * 区间约定：affinity/familiarity ∈ [0,100]，mood ∈ [-50,+50]。
 */
import type { AgentLabMemberKind, AgentLabRelation } from './types';

export const RELATION_AFFINITY_RANGE = { min: 0, max: 100 } as const;
export const RELATION_FAMILIARITY_RANGE = { min: 0, max: 100 } as const;
export const RELATION_MOOD_RANGE = { min: -50, max: 50 } as const;

/** 中性基线：刚认识、没什么好感也没恶感。M4 会用 deep.relationship 蒸一个更贴切的初值覆盖。 */
export const NEUTRAL_AFFINITY = 50;
export const NEUTRAL_FAMILIARITY = 10;

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/** 造一个中性初值关系态。 */
export function makeBaseRelation(
  subjectPersonaId: string,
  objectId: string,
  objectKind: AgentLabMemberKind,
  now: number,
  overrides?: Partial<Pick<AgentLabRelation, 'affinity' | 'familiarity' | 'mood'>>,
): AgentLabRelation {
  return {
    subjectPersonaId,
    objectId,
    objectKind,
    affinity: clamp(overrides?.affinity ?? NEUTRAL_AFFINITY, RELATION_AFFINITY_RANGE.min, RELATION_AFFINITY_RANGE.max),
    familiarity: clamp(
      overrides?.familiarity ?? NEUTRAL_FAMILIARITY,
      RELATION_FAMILIARITY_RANGE.min,
      RELATION_FAMILIARITY_RANGE.max,
    ),
    mood: clamp(overrides?.mood ?? 0, RELATION_MOOD_RANGE.min, RELATION_MOOD_RANGE.max),
    interactionCount: 0,
    lastInteractAt: now,
    updatedAt: now,
  };
}

/** 把各维度 clamp 回合法区间（防越界，防 NaN）。 */
export function clampRelation(rel: AgentLabRelation): AgentLabRelation {
  return {
    ...rel,
    affinity: clamp(rel.affinity, RELATION_AFFINITY_RANGE.min, RELATION_AFFINITY_RANGE.max),
    familiarity: clamp(rel.familiarity, RELATION_FAMILIARITY_RANGE.min, RELATION_FAMILIARITY_RANGE.max),
    mood: clamp(rel.mood, RELATION_MOOD_RANGE.min, RELATION_MOOD_RANGE.max),
  };
}

/**
 * mood 随时间回落到 0（每天衰减约 `perDay`）。读取关系态时惰性调用，避免定时任务。
 * elapsedMs 为距上次更新的毫秒数。
 */
export function decayMood(mood: number, elapsedMs: number, perDay = 25): number {
  if (mood === 0 || elapsedMs <= 0) return mood;
  const days = elapsedMs / (24 * 3600 * 1000);
  const shrink = days * perDay;
  if (mood > 0) return Math.max(0, mood - shrink);
  return Math.min(0, mood + shrink);
}

/**
 * 把关系态翻译成一句「此刻对 TA 的感觉」的语气指令，注入 prompt 让克隆体的语气随关系变化。
 * 中性（好感一般 + 情绪平）时返回空串，避免往 prompt 里塞噪声。
 */
export function describeRelationTone(rel: AgentLabRelation): string {
  const parts: string[] = [];
  const a = rel.affinity;
  if (a >= 78) parts.push('你挺喜欢、也挺信任这个人，语气自然亲近热络');
  else if (a >= 62) parts.push('你和这个人关系不错，语气自然放松些');
  else if (a <= 22) parts.push('你和这个人不太对付，语气疏离、别太热情');
  else if (a <= 38) parts.push('你和这个人不算熟，语气客气但有点距离感');

  if (rel.mood >= 18) parts.push('你现在心情不错，愿意多聊两句');
  else if (rel.mood <= -18) parts.push('你现在对 TA 有点不爽，回得敷衍冷淡些、甚至可以不太想接话');

  if (parts.length === 0) return '';
  return `你此刻对 TA 的感觉：${parts.join('；')}。（自然体现在语气里，别直接说出来。）`;
}

/** 纯函数：对一个关系态施加增量，clamp 后返回新对象（互动计数 +1）。 */
export function applyRelationDelta(
  base: AgentLabRelation,
  delta: { affinity?: number; familiarity?: number; mood?: number },
  now: number,
): AgentLabRelation {
  return clampRelation({
    ...base,
    affinity: base.affinity + (delta.affinity ?? 0),
    familiarity: base.familiarity + (delta.familiarity ?? 0),
    mood: base.mood + (delta.mood ?? 0),
    interactionCount: base.interactionCount + 1,
    lastInteractAt: now,
    updatedAt: now,
  });
}
