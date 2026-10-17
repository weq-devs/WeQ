/**
 * Lightweight word segmentation for chat analytics (常用语 + 词云).
 *
 * Three tiers, best first:
 *
 *   1. QQ's own bundled jieba dictionary (`nt_data/search/resource_jieba`,
 *      resolved via `Platform.jiebaDictDir`). It knows Chinese technical words
 *      ICU misses (密钥 / 重启 / 二维码 / 安装包…) so 词云 stops dropping them.
 *      Loaded lazily by the host — see {@link warmJiebaDict}.
 *   2. The runtime's built-in `Intl.Segmenter` (ICU dictionary-based word
 *      breaking, shipped with Electron's full-ICU build).
 *   3. A regex tokenizer (CJK bigrams + ASCII words) when neither is available.
 *
 * Whichever tier runs, the same stopword / single-char / function-char filter
 * below is applied, so the token shape stays stable across tiers.
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

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
}

let cachedSegmenter: SegmenterLike | null | undefined;

/**
 * QQ 词典分词器（进程级单例）。词典是账号无关的通用资源，所以只加载一次；
 * 加载失败或未加载时 `segmentWords` 自动回落到 `Intl.Segmenter`。
 */
let jiebaSegmenter: Segmenter | null = null;
let jiebaLoad: Promise<void> | null = null;

/**
 * 异步加载 QQ 自带的结巴词典并安装到进程级分词器上。幂等：只认首次调用。
 *
 * `dir` 来自 `Platform.jiebaDictDir()`，读不到（新装 QQ 没搜过、静态账号）时直接
 * 跳过 —— 调用方 fire-and-forget 即可，`segmentWords` 永远有兜底路径。
 */
export function warmJiebaDict(dir: string | null): Promise<void> {
  if (jiebaLoad) return jiebaLoad;
  if (!dir) return Promise.resolve();
  jiebaLoad = (async () => {
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
    } catch {
      // 主词典读不到就整体放弃，回落到内置分词器。
      jiebaSegmenter = null;
      setDefaultSegmenter(null);
    }
  })();
  return jiebaLoad;
}

/** 测试钩子：清空已加载的词典单例，让用例能重放「未加载」状态。 */
export function __resetJiebaForTest(): void {
  jiebaSegmenter = null;
  jiebaLoad = null;
  setDefaultSegmenter(null);
}

function getSegmenter(): SegmenterLike | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  try {
    const Seg = (
      Intl as unknown as {
        Segmenter?: new (locale: string, opts: { granularity: string }) => SegmenterLike;
      }
    ).Segmenter;
    cachedSegmenter = Seg ? new Seg('zh', { granularity: 'word' }) : null;
  } catch {
    cachedSegmenter = null;
  }
  return cachedSegmenter;
}

const CJK_RE = /[一-鿿㐀-䶿]/;
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
  // 优先用 QQ 词典（若宿主已加载）：它认得 ICU 会切碎的技术词。
  if (jiebaSegmenter) {
    for (const piece of jiebaSegmenter.cut(cleaned)) {
      const w = normalize(piece);
      if (w) out.push(w);
    }
    return out;
  }

  const seg = getSegmenter();
  if (seg) {
    for (const piece of seg.segment(cleaned)) {
      if (piece.isWordLike === false) continue;
      const w = normalize(piece.segment);
      if (w) out.push(w);
    }
    return out;
  }

  // Fallback: CJK runs → bigrams, ASCII → whole words.
  const tokens = cleaned.match(/[一-鿿㐀-䶿]+|[A-Za-z][A-Za-z']+/g) ?? [];
  for (const t of tokens) {
    if (CJK_RE.test(t)) {
      if (t.length <= 3) {
        const w = normalize(t);
        if (w) out.push(w);
      } else {
        for (let i = 0; i + 2 <= t.length; i++) {
          const w = normalize(t.slice(i, i + 2));
          if (w) out.push(w);
        }
      }
    } else {
      const w = normalize(t);
      if (w) out.push(w);
    }
  }
  return out;
}
