/**
 * Lightweight word segmentation for chat analytics (常用语 + 词云).
 *
 * Two dictionary sources, best first:
 *
 *   1. QQ's own bundled jieba dictionary (`nt_data/search/resource_jieba`,
 *      resolved via `Platform.jiebaDictDir`).
 *   2. The copy shipped in the repo's `resources/jieba/` (same three files),
 *      used when QQ has not downloaded its own yet.
 *
 * Both are the same dictionary format, so the stopword / single-char /
 * function-char filter below stays the only token-shape rule. Loading is done
 * lazily by the host — see {@link warmJiebaDict}.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createJiebaSegmenter,
  setDefaultSegmenter,
  normalizeChatToken,
  type JiebaDictText,
  type Segmenter,
} from '@weq/agentlab';

/**
 * QQ 词典分词器（进程级单例）。词典是账号无关的通用资源，所以只加载一次；
 * 未加载时 `segmentWords` 返回空数组（调用方拿到空词云，不会崩）。
 */
let jiebaSegmenter: Segmenter | null = null;
let jiebaLoad: Promise<void> | null = null;

/**
 * 异步加载结巴词典并安装到进程级分词器上。幂等：只认首次调用。
 *
 * `dirs` 按优先级排列（宿主传 `[QQ 词典目录, resources/jieba]`），逐个尝试；
 * 全部读不到时静默跳过 —— 调用方 fire-and-forget 即可。
 */
export function warmJiebaDict(dirs: readonly (string | null)[]): Promise<void> {
  if (jiebaLoad) return jiebaLoad;
  jiebaLoad = (async () => {
    for (const dir of dirs) {
      if (!dir) continue;
      try {
        const [jiebaDict, userDict, hmmModel] = await Promise.all([
          readFile(join(dir, 'jieba_dict.utf8'), 'utf8'),
          readFile(join(dir, 'user_dict.utf8'), 'utf8').catch(() => undefined),
          readFile(join(dir, 'hmm_model.utf8'), 'utf8').catch(() => undefined),
        ]);
        const text: JiebaDictText = { jiebaDict, userDict, hmmModel };
        jiebaSegmenter = createJiebaSegmenter(text);
        // agentlab 的「常用语 / 关键词」也共用这份词典，避免两套切法。
        setDefaultSegmenter(jiebaSegmenter);
        return;
      } catch {
        // 这一份不可用，试下一份。
      }
    }
    jiebaSegmenter = null;
    setDefaultSegmenter(null);
  })();
  return jiebaLoad;
}

/** 测试钩子：清空已加载的词典单例，让用例能重放「未加载」状态。 */
export function __resetJiebaForTest(): void {
  jiebaSegmenter = null;
  jiebaLoad = null;
  setDefaultSegmenter(null);
}

const URL_RE = /https?:\/\/\S+/gi;

/** Normalize a raw token; returns null when it should be dropped. */
function normalize(raw: string): string | null {
  return normalizeChatToken(raw);
}

/**
 * Segment a piece of chat text into meaningful words (stopwords / single
 * chars / pure numbers / punctuation removed). Order-preserving, duplicates
 * kept so the caller can tally frequencies.
 */
export function segmentWords(text: string): string[] {
  if (!text) return [];
  const cleaned = text.replace(URL_RE, ' ').trim();
  if (!cleaned) return [];

  const out: string[] = [];
  if (!jiebaSegmenter) return out;
  const pieces = jiebaSegmenter.cutForChat?.(cleaned) ?? jiebaSegmenter.cut(cleaned);
  for (const piece of pieces) {
    const w = normalize(piece);
    if (w) out.push(w);
  }
  return out;
}
