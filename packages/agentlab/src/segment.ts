/**
 * 结巴（jieba）风格的中文分词器 —— 纯计算，不做任何文件 IO。
 *
 * QQ NT 自带一份结巴词典（`nt_data/search/resource_jieba`：主词典 + 用户词典 +
 * HMM 模型）。本模块把这份词典喂进来，产出一个可复用的分词器：
 *
 *   1. **词典 + 动态规划**：对每个中文连续段求「词频对数之和最大」的切分，
 *      这比朴素最大匹配更接近结巴的精度（新词、歧义切分都更稳）；
 *   2. **HMM（Viterbi）兜底**：词典里查不到的生词串（人名、网络新词）用
 *      B/E/M/S 四态隐马模型猜词边界 —— 没有它，生词会被切成单字丢掉。
 *
 * 切词与过滤分开：`cut()` 只负责切分；`tokenizeText()` 面向「常用语 /
 * 关键词」会套用 {@link normalizeChatToken} 的停用词规则。结巴式分词器本身
 * 不做过滤，调用方需要原始切分时可以直接用 `cut()`。
 */

import { normalizeChatToken } from './stopwords';

/** 一个把文本切成词的切分器。 */
export interface Segmenter {
  cut(text: string): string[];
}

/**
 * 进程级默认切分器（可选）。宿主（如 `@weq/service`）加载了 QQ 结巴词典后
 * 通过 {@link setDefaultSegmenter} 装进来，`persona` / `http` 的「常用语 /
 * 关键词」提取就会以真实的词为单位，而不是把整段中文当一个 token。
 * 未设置时各处保留原有的正则切分，行为不变。
 */
let defaultSegmenter: Segmenter | null = null;

/** 安装 / 清空进程级默认切分器。 */
export function setDefaultSegmenter(segmenter: Segmenter | null): void {
  defaultSegmenter = segmenter;
}

/**
 * 关键词 / 常用语提取用的通用切词：装了默认切分器（QQ 词典）就按词切，
 * 否则退回原有的「非中英数字符即分隔」正则。两边共用
 * {@link normalizeChatToken}，与 `@weq/service` 的词云 / 口头禅过滤口径一致。
 */
export function tokenizeText(text: string): string[] {
  const seg = defaultSegmenter;
  const raw = seg ? seg.cut(text) : text.split(/[^a-z0-9\u4e00-\u9fa5]+/i);
  const out: string[] = [];
  for (const item of raw) {
    const w = normalizeChatToken(item);
    if (w) out.push(w);
  }
  return out;
}

/** 结巴词典的原始文本内容（三份文件都可以缺，缺的部分相应降级）。 */
export interface JiebaDictText {
  /** `jieba_dict.utf8`：主词典，每行 `词 词频 [词性]`。 */
  jiebaDict?: string;
  /** `user_dict.utf8`：用户词典，每行 `词 [词频] [词性]`，无词频视为强制成词。 */
  userDict?: string;
  /** `hmm_model.utf8`：HMM 模型（起始/转移/发射概率）。 */
  hmmModel?: string;
}

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const ASCII_WORD_RE = /^[A-Za-z][A-Za-z0-9_'.#+-]*/;
const DIGIT_RE = /^\d+/;
/** 最长词长度上限，防个别超长词条把 DP 窗口撑爆。 */
const MAX_WORD_LEN = 24;
/** 对数零：用结巴同款极小概率表示「不可能」。 */
const NEG_INF = -3.14e100;

interface DictState {
  /** 词 → 词频（含用户词典的强制词）。 */
  freq: Map<string, number>;
  /** 词频总和。 */
  total: number;
  /** 最长词条长度（截到 MAX_WORD_LEN）。 */
  maxLen: number;
  /** 词典中最大的词频，供用户词无词频时取一个稳压一切的值。 */
  maxFreq: number;
}

function parseDictText(dict: DictState, text: string, forced: boolean): void {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    const word = parts[0];
    if (!word) continue;
    const freqField = parts[1];
    const hasFreq = freqField !== undefined && /^\d+$/.test(freqField);
    if (hasFreq) {
      const value = Number.parseInt(freqField, 10);
      dict.freq.set(word, value);
      dict.total += value;
      if (value > dict.maxFreq) dict.maxFreq = value;
    } else if (forced) {
      // 无词频的用户词：先记 0，待全程扫完再用 maxFreq 抬到最高。
      dict.freq.set(word, 0);
    }
    const len = Math.min(word.length, MAX_WORD_LEN);
    if (len > dict.maxLen) dict.maxLen = len;
  }
}

function buildDict(text: JiebaDictText): DictState {
  const dict: DictState = { freq: new Map(), total: 0, maxLen: 1, maxFreq: 1 };
  if (text.jiebaDict) parseDictText(dict, text.jiebaDict, false);
  // 用户词记 0，扫完再统一抬升；这样它们一定胜过主词典里的细分路径。
  if (text.userDict) parseDictText(dict, text.userDict, true);
  const forcedFreq = Math.max(dict.maxFreq, dict.total, 1);
  for (const [word, value] of dict.freq) {
    if (value === 0) {
      dict.freq.set(word, forcedFreq);
      dict.total += forcedFreq;
    }
  }
  if (dict.total <= 0) dict.total = 1;
  return dict;
}

interface HmmModel {
  /** 四态的起始 log 概率，下标同 `STATES`。 */
  start: number[];
  /** `trans[prev][cur]`。 */
  trans: number[][];
  /** 四态各自的发射概率表。 */
  emit: Map<string, number>[];
}

/** 状态顺序：B(词首) E(词尾) M(词中) S(单字)。 */
const STATES = ['B', 'E', 'M', 'S'] as const;
/** 允许的前驱状态（下标），`PREV[cur] = [prev...]`。 */
const PREV: readonly number[][] = [
  [1, 3],
  [0, 2],
  [0, 2],
  [3, 1],
];

function parseHmm(text: string | undefined): HmmModel | null {
  if (!text) return null;
  const start: number[] = [];
  const trans: number[][] = [];
  const emit: Map<string, number>[] = [];
  let mode = '';
  for (const rawLine of text.split('\n')) {
    const line = rawLine;
    if (line.startsWith('#prob_start')) {
      mode = 'start';
      continue;
    }
    if (line.startsWith('#prob_trans')) {
      mode = 'trans';
      continue;
    }
    if (line.startsWith('#prob_emit')) {
      mode = 'emit';
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    if (mode === 'start') {
      for (const value of line.trim().split(/\s+/)) start.push(Number(value));
    } else if (mode === 'trans') {
      trans.push(line.trim().split(/\s+/).map(Number));
    } else if (mode === 'emit') {
      const table = new Map<string, number>();
      for (const pair of line.split(',')) {
        const idx = pair.lastIndexOf(':');
        if (idx <= 0) continue;
        table.set(pair.slice(0, idx), Number(pair.slice(idx + 1)));
      }
      emit.push(table);
    }
  }
  if (
    start.length !== STATES.length ||
    trans.length !== STATES.length ||
    emit.length !== STATES.length
  ) {
    return null;
  }
  return { start, trans, emit };
}

/**
 * 对一串「词典里查不到的生字」跑 Viterbi，猜出词边界。
 * 返回值按原顺序切好，拼接起来等于输入。
 */
function hmmCut(chars: readonly string[], model: HmmModel): string[] {
  const n = chars.length;
  if (n === 0) return [];
  if (n === 1) return [chars[0]!];

  // back[t][cur] = 第 t 步取 cur 状态时的最优前驱下标。
  const back: number[][] = [];
  let prev: number[] = STATES.map(
    (_, state) => (model.start[state] ?? NEG_INF) + (model.emit[state]?.get(chars[0]!) ?? NEG_INF),
  );
  for (let t = 1; t < n; t++) {
    const cur: number[] = [];
    const backRow: number[] = [];
    for (let state = 0; state < STATES.length; state++) {
      let best = -Infinity;
      let bestPrev = 0;
      for (const p of PREV[state] ?? []) {
        const value = (prev[p] ?? NEG_INF) + (model.trans[p]?.[state] ?? NEG_INF);
        if (value > best) {
          best = value;
          bestPrev = p;
        }
      }
      cur[state] = best + (model.emit[state]?.get(chars[t]!) ?? NEG_INF);
      backRow[state] = bestPrev;
    }
    back.push(backRow);
    prev = cur;
  }

  // 收尾状态只能是 E(词尾) 或 S(单字)。
  let end = (prev[1] ?? NEG_INF) > (prev[3] ?? NEG_INF) ? 1 : 3;
  const path = [end];
  for (let t = n - 1; t > 0; t--) {
    end = back[t]?.[end] ?? 0;
    path.push(end);
  }
  path.reverse();

  const out: string[] = [];
  let buffer = '';
  for (let i = 0; i < n; i++) {
    const state = STATES[path[i] ?? 3];
    const ch = chars[i]!;
    if (state === 'B') buffer = ch;
    else if (state === 'M') buffer += ch;
    else if (state === 'E') {
      out.push(buffer + ch);
      buffer = '';
    } else {
      if (buffer) {
        out.push(buffer);
        buffer = '';
      }
      out.push(ch);
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

/** 单个中文连续段的词典 DP：返回词数组，长度和为输入长度。 */
function dictCut(run: string, dict: DictState, logTotal: number): string[] {
  const n = run.length;
  // best[a] = 从 a 到末尾的最优对数似然；pick[a] = 该位置选中的词长。
  const best: number[] = new Array(n + 1).fill(-Infinity);
  const pick: number[] = new Array(n).fill(1);
  best[n] = 0;
  for (let a = n - 1; a >= 0; a--) {
    let bestValue = -Infinity;
    let bestLen = 1;
    const cap = Math.min(dict.maxLen, n - a);
    for (let len = cap; len >= 1; len--) {
      const word = run.slice(a, a + len);
      const freq = dict.freq.get(word);
      // 未知词只有单字候选（freq 记 1），多字未知串交给 HMM。
      if (freq === undefined && len > 1) continue;
      const value = Math.log(freq ?? 1) - logTotal + (best[a + len] ?? -Infinity);
      if (value > bestValue) {
        bestValue = value;
        bestLen = len;
      }
    }
    best[a] = bestValue;
    pick[a] = bestLen;
  }

  const out: string[] = [];
  let a = 0;
  while (a < n) {
    const len = pick[a] ?? 1;
    const word = run.slice(a, a + len);
    // 未知单字原样吐出，由调用方攒起来交给 HMM（这里合并会破坏 HMM 的边界猜测）。
    out.push(word);
    a += len;
  }
  return out;
}

/**
 * 用结巴词典文本构造一个分词器。
 *
 * 三份文本都可选：只给主词典也能用（无 HMM 时生词退化为单字），全缺则退化为
 * 「中文按字、英文按词」的朴素切分 —— 调用方仍可安全调用 `cut`。
 */
export function createJiebaSegmenter(text: JiebaDictText): Segmenter {
  const dict = buildDict(text);
  const logTotal = Math.log(dict.total);
  const hmm = parseHmm(text.hmmModel);

  return {
    cut(input: string): string[] {
      if (!input) return [];
      const out: string[] = [];
      let i = 0;
      while (i < input.length) {
        const ch = input[i]!;
        if (!CJK_RE.test(ch)) {
          const rest = input.slice(i);
          const ascii = ASCII_WORD_RE.exec(rest);
          if (ascii) {
            out.push(ascii[0].toLowerCase());
            i += ascii[0].length;
            continue;
          }
          const digits = DIGIT_RE.exec(rest);
          if (digits) {
            out.push(digits[0]);
            i += digits[0].length;
            continue;
          }
          i += 1;
          continue;
        }
        let j = i;
        while (j < input.length && CJK_RE.test(input[j]!)) j++;
        const run = input.slice(i, j);
        // 词典 DP 出来的「未知单字」要攒起来一起交给 HMM 猜边界，单独一个字
        // 丢给 HMM 等于没兜底（生词会被切成单字）。
        let unknown: string[] = [];
        const flushUnknown = (): void => {
          if (unknown.length === 0) return;
          out.push(...(hmm ? hmmCut(unknown, hmm) : unknown));
          unknown = [];
        };
        for (const piece of dictCut(run, dict, logTotal)) {
          if (piece.length === 1 && dict.freq.get(piece) === undefined) {
            unknown.push(piece);
          } else {
            flushUnknown();
            out.push(piece);
          }
        }
        flushUnknown();
        i = j;
      }
      return out;
    },
  };
}
