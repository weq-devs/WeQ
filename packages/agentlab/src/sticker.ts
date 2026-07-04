/**
 * 表情选择与发送逻辑（参考 MaiBot emoji_manager）
 */
import type { AgentLabStickerRef, AgentLabPersona } from './types';

/** Levenshtein 距离（编辑距离），用滚动 1D 数组实现。 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // prev[j] = 上一行的编辑距离；逐行滚动更新。
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (cur[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      cur[j] = Math.min(del, ins, sub);
    }
    prev = cur;
  }
  return prev[n] ?? 0;
}

/** 计算情绪标签相似度（1 - 归一化编辑距离） */
function emotionSimilarity(emotion: string, target: string): number {
  const e = emotion.toLowerCase().trim();
  const t = target.toLowerCase().trim();
  if (!e || !t) return 0;
  const dist = levenshtein(e, t);
  const maxLen = Math.max(e.length, t.length);
  return maxLen > 0 ? 1 - dist / maxLen : 0;
}

/** 从表情描述/场景里提取可能的情绪标签（简单分词） */
function extractEmotions(text: string): string[] {
  if (!text) return [];
  // 简单按标点/空格拆分，保留 2-6 字的中文短语或单词
  return text
    .split(/[，。、；：！？\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 6);
}

/** 两段文本的共享字符占比（对中文情绪词比纯编辑距离更稳）。 */
function charOverlap(a: string, b: string): number {
  const sa = new Set(a);
  if (sa.size === 0) return 0;
  let hit = 0;
  for (const ch of new Set(b)) if (sa.has(ch)) hit += 1;
  return hit / sa.size;
}

/**
 * 给表情打分：目标情绪 vs 表情的「描述 + 场景」全文。
 * 三档信号叠加（取最强）：子串包含 > 共享字符 > 编辑距离相似。
 * 中文情绪词很短，纯编辑距离常年 0，所以包含/共享字符才是主力。
 */
function scoreStickerForEmotion(sticker: AgentLabStickerRef, targetEmotion: string): number {
  const target = targetEmotion.toLowerCase().trim();
  if (!target) return 0;
  const contexts = (sticker.contexts ?? []).join(' ');
  const full = `${sticker.description} ${sticker.scenario} ${contexts}`.toLowerCase();
  const candidates = [
    ...extractEmotions(sticker.description),
    ...extractEmotions(sticker.scenario),
    ...extractEmotions(contexts),
  ];

  let best = 0;
  // 1) 整体包含：情绪词出现在描述/场景里（或反过来），最强信号。
  if (full.includes(target)) best = Math.max(best, 0.9);
  // 2) 逐标签比对：包含 / 共享字符 / 编辑距离。
  for (const c of candidates) {
    const cl = c.toLowerCase();
    if (cl.includes(target) || target.includes(cl)) best = Math.max(best, 0.85);
    best = Math.max(best, charOverlap(target, cl) * 0.8);
    best = Math.max(best, emotionSimilarity(cl, target));
  }
  // 描述整体的共享字符兜底（场景描述较长时有用）。
  best = Math.max(best, charOverlap(target, full) * 0.6);

  // 高频表情微弱加权（使用次数越多越可能再用）。
  return best + Math.log1p(sticker.count) * 0.05;
}

/**
 * 随机挑一张表情（供「随机发」通路：模型输出 emoji content=random 时用）。
 * preferUndescribed=true 时优先从「没有文字描述」的表情里挑——这正是刚导入、还没被视觉模型
 * 解析过的新表情，让它们也有机会被发出去（否则永远进不了编号清单）。子集为空则回退全部。
 */
export function pickRandomSticker(
  persona: AgentLabPersona,
  opts?: { preferUndescribed?: boolean },
): AgentLabStickerRef | null {
  const all = persona.stickers ?? [];
  if (all.length === 0) return null;
  const undescribed = all.filter((s) => !s.description && !s.scenario);
  const pool = opts?.preferUndescribed && undescribed.length > 0 ? undescribed : all;
  return pool[Math.floor(Math.random() * pool.length)] ?? null;
}

/** 从 persona.stickers 里选出最匹配 targetEmotion 的表情；都不沾边时返回高频兜底。 */
export function selectStickerByEmotion(
  persona: AgentLabPersona,
  targetEmotion: string,
): AgentLabStickerRef | null {
  const stickers = (persona.stickers ?? []).filter(
    (s) => s.description || s.scenario || (s.contexts ?? []).length > 0,
  );
  if (stickers.length === 0) return null;

  const scored = stickers
    .map((s) => ({ sticker: s, score: scoreStickerForEmotion(s, targetEmotion) }))
    .sort((a, b) => b.score - a.score);

  // 阈值放宽到 0.3：宁可发个差不多的，也别因为没"完全对上"就退回文字。
  const top = scored[0];
  if (top && top.score >= 0.3) return top.sticker;

  // 完全匹配不上时，既然模型已经决定要发表情，就退回 TA 最常用的那张，别空着。
  return [...stickers].sort((a, b) => b.count - a.count)[0] ?? null;
}
