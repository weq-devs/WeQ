/**
 * Lightweight word segmentation for chat analytics (常用语 + 词云).
 *
 * Uses the runtime's built-in `Intl.Segmenter` (ICU dictionary-based word
 * breaking, shipped with Electron's full-ICU build) so Chinese is segmented
 * into real words without any native dependency. Falls back to a regex
 * tokenizer (CJK bigrams + ASCII words) when the segmenter is unavailable.
 */

interface SegmenterLike {
  segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>;
}

let cachedSegmenter: SegmenterLike | null | undefined;

function getSegmenter(): SegmenterLike | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  try {
    const Seg = (Intl as unknown as {
      Segmenter?: new (locale: string, opts: { granularity: string }) => SegmenterLike;
    }).Segmenter;
    cachedSegmenter = Seg ? new Seg('zh', { granularity: 'word' }) : null;
  } catch {
    cachedSegmenter = null;
  }
  return cachedSegmenter;
}

const CJK_RE = /[一-鿿㐀-䶿]/;
const URL_RE = /https?:\/\/\S+/gi;

/**
 * Common Chinese/English function words and chat noise. Dropping these keeps
 * the "常用语"/词云 focused on meaningful words rather than 的/了/我/你 等虚词.
 */
const STOPWORDS = new Set<string>([
  // 结构性中文虚词 / 高频噪声
  '的', '了', '是', '我', '你', '他', '她', '它', '们', '在', '也', '都', '就', '不', '和',
  '啊', '吧', '呢', '吗', '哦', '嗯', '哈', '呀', '么', '什么', '怎么', '这个', '那个', '这',
  '那', '有', '个', '要', '会', '到', '说', '想', '看', '被', '把', '给', '跟', '为', '对',
  '与', '及', '或', '但', '而', '并', '还', '又', '很', '太', '更', '最', '没', '没有',
  '可以', '一个', '一下', '一些', '现在', '已经', '因为', '所以', '如果', '然后', '这样',
  '那样', '知道', '觉得', '可能', '应该', '其实', '感觉', '时候', '大家', '自己', '我们',
  '你们', '他们', '这种', '一点', '不是', '就是', '还是', '这么', '那么', '只是',
  // English
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in',
  'on', 'at', 'for', 'it', 'this', 'that', 'you', 'me', 'my', 'your', 'we', 'they', 'he',
  'she', 'i', 'im', 'so', 'do', 'does', 'no', 'yes', 'ok', 'okay', 'lol', 'haha', 'with',
  'just', 'not', 'can', 'as', 'if', 'by',
]);

/**
 * Single "function characters" — pronouns, particles, copulas, prepositions,
 * conjunctions and bare adverbs that don't form meaningful content words on
 * their own. A short CJK word made up *entirely* of these (我的 / 你是 / 我是 /
 * 就是 …) is grammatical glue with no value in a word cloud, so it's dropped.
 * Content words almost always contain at least one non-function char (中国 /
 * 喜欢 / 好人 survive), so this stays safe.
 */
const FUNCTION_CHARS = new Set<string>(
  ('我你他她它您咱们的了着过得地是在和与跟把被让给将对向从这那哪啊呀吧呢吗哦嗯哈嘛' +
    '啦咯呐之其此也都就还又才只很太更挺不没别么麽要会能可好有个把且并而或如若因故则')
    .split(''),
);

function isAllFunctionChars(word: string): boolean {
  for (const ch of word) {
    if (!FUNCTION_CHARS.has(ch)) return false;
  }
  return true;
}

/** Normalize a raw token; returns null when it should be dropped. */
function normalize(raw: string): string | null {
  const w = raw.trim().toLowerCase();
  if (w.length < 2) return null; // single chars are too noisy
  if (/^\d+$/.test(w)) return null; // pure numbers
  if (!/[一-鿿a-z]/i.test(w)) return null; // must contain a letter or CJK
  if (STOPWORDS.has(w)) return null;
  // 短词若全部由虚词字组成（我的/你是/就是…），视为无意义。
  if (w.length <= 3 && isAllFunctionChars(w)) return null;
  return w;
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
