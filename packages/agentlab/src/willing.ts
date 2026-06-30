/**
 * 回复意愿评分（借鉴 MaiBot `reply_necessity` / willing）。
 *
 * 视角转换：MaiBot 判断「要不要回」，但 WeQ 是 1:1 测试聊天，用户发了就一定会收到回复——
 * 所以这里把意愿用来调节「回得多上心」：意愿高 → 回得快、可以多分几条；意愿低 → 敷衍、慢、就一两条。
 * 因子沿用 MaiBot 那套（内容分 + 存在感惩罚），但归一化到 0~1。
 */
import type { AgentLabChatTurn } from './types';

const QUESTION_RE = /[?？]|吗[?？。!！]?$|呢[?？。!！]?$|怎么|为什么|为啥|咋|多少|哪|几点/;
const REQUEST_RE = /帮我|帮忙|能不能|可不可以|可以吗|行不行|给我|教我|怎么弄|怎么搞/;
const OPINION_RE = /你觉得|你认为|你说|你看|怎么样|如何|好不好|对吧/;
const SHORT_REACTIONS = new Set(['嗯', '哦', '噢', '额', '啊', '在', '？', '?', '。', '哈', '哈哈', '嗯嗯', '好', '好的', 'ok', 'OK']);

export interface WillingnessResult {
  /** 0~1，越高越上心。 */
  score: number;
  /** 建议首条回复前延迟（ms），模拟「在打字」。 */
  replyDelayMs: number;
  /** 建议最多分几条（意愿低 → 少分）。 */
  maxSegments: number;
}

/**
 * 评估克隆体对这句话的回复意愿。`history` 不含当前这句（用于算克隆体最近的存在感）。
 */
export function scoreReplyWillingness(input: string, history: AgentLabChatTurn[]): WillingnessResult {
  const text = input.trim();
  let score = 0.6; // 1:1 私聊基准就不低

  // 内容分：被提问 / 被请求 / 被征询意见 → 更想好好回。
  if (QUESTION_RE.test(text)) score += 0.18;
  if (REQUEST_RE.test(text)) score += 0.15;
  if (OPINION_RE.test(text)) score += 0.15;
  if (text.length >= 40) score += 0.06;
  else if (text.length >= 16) score += 0.03;

  // 敷衍触发：对方只丢了个单字/语气词 → 克隆体也懒得长篇。
  if (SHORT_REACTIONS.has(text) || text.length <= 2) score -= 0.18;

  // 存在感惩罚：最近几轮里克隆体说得越多，越收着点（避免一直滔滔不绝）。
  const recent = history.slice(-8);
  const selfShare = recent.length > 0 ? recent.filter((t) => t.role === 'assistant').length / recent.length : 0;
  if (selfShare > 0.6) score -= 0.12;

  score = Math.max(0.15, Math.min(1, score));

  // 意愿越低，回得越慢、分条越少。
  const replyDelayMs = Math.round(350 + (1 - score) * 1300);
  const maxSegments = score < 0.4 ? 2 : score < 0.7 ? 3 : 4;

  return { score, replyDelayMs, maxSegments };
}
