/**
 * Intent-sense local-engine worker — 在 fork 出来的子进程里跑 Laya 多语言
 * System-1 决策模型（ONNX Runtime），主进程经 {@link bridge.ts} 桥接调用。
 *
 * 为什么是子进程：onnxruntime-node 的原生运行时与 600MB 级会话初始化都不该
 * 进 Electron 主进程（崩溃即全应用退出 + 推理阻塞 IPC）。这里与
 * transcribe/worker.ts 同一套打包/寻址约定：electron-vite 单独入口
 * （intentSenseWorker.mjs）、`@receptron/laya` 保持 external（运行时从
 * node_modules require，打包时 asarUnpack）。
 *
 * 协议（长驻，非一次性）：
 *   → { type:'load', modelDir }
 *   ← { type:'ready' } | { type:'load-error', error }
 *   → { type:'analyze', id, text }        ← { type:'result', id, … } | { type:'analyze-error', id, error }
 *   → { type:'mbti', id, samples }        ← { type:'mbti-result', id, dims } | { type:'analyze-error', id, error }
 *   → { type:'close' }
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const requireFn = createRequire(__filename);

/** 与 @weq/service 的 INTENT_LABELS / EMOTION_LABELS 键保持一致。 */
const INTENT_CRITERIA: Record<string, string> = {
  question: '提出问题、寻求信息或答案',
  request: '请求对方做某事、求助',
  greeting: '打招呼、问候、寒暄',
  share: '分享见闻、经历、链接、图片内容',
  vent: '吐槽、抱怨、发泄情绪',
  joke: '开玩笑、玩梗、调侃、发搞笑内容',
  plan: '商量或约定要做的事（时间地点安排）',
  info: '通知、告知事实、同步进展',
  chat: '没有明确目的的日常闲聊',
  other: '以上都不符合',
};

const EMOTION_CRITERIA: Record<string, string> = {
  joy: '开心、愉快、满足',
  excitement: '兴奋、激动、期待',
  neutral: '平静、无明显情绪',
  sadness: '低落、难过、失落',
  anger: '生气、不满、烦躁',
  anxiety: '焦虑、担心、紧张',
  affection: '亲昵、撒娇、关心、善意',
  fatigue: '疲惫、倦怠、没精力',
  curiosity: '好奇、感兴趣、想知道',
};

const INTENSITY_LEVELS = ['几乎没有情绪', '轻微', '中等', '强烈', '极其强烈'];
const SENTIMENT_LEVELS = ['非常消极', '比较消极', '偏中性', '比较积极', '非常积极'];

const MBTI_QUESTIONS = {
  EI: {
    type: 'score',
    instructions:
      '综合这些私聊消息，此人的性格更偏外向（主动社交、话多）还是内向（被动回应、话少）？从低到高打分。',
    criteria: ['明显内向', '偏内向', '居中', '偏外向', '明显外向'],
  },
  SN: {
    type: 'score',
    instructions:
      '此人聊天更关注具体实际的事（事实、细节、当下），还是抽象的想法（联想、概念、可能性）？低=具体实际，高=抽象想象。',
    criteria: ['明显务实具体', '偏务实', '居中', '偏想象', '明显抽象想象'],
  },
  TF: {
    type: 'score',
    instructions:
      '此人表达时更偏理性逻辑（讲道理、就事论事），还是偏情感（谈感受、共情、情绪化）？低=理性，高=情感。',
    criteria: ['明显理性', '偏理性', '居中', '偏情感', '明显情感'],
  },
  JP: {
    type: 'score',
    instructions:
      '此人做事风格更有计划条理（明确安排、按时守约），还是随性灵活（随缘、临时起意）？低=有计划，高=随性。',
    criteria: ['明显有计划', '偏有计划', '居中', '偏随性', '明显随性'],
  },
} as const;

interface AnalyzeResultMessage {
  type: 'result';
  id: number;
  intent: string;
  emotion: string;
  intensity: number;
  sentiment: number;
  confidence: number;
}

/** worker → 主进程的消息并集（process.send 接受可序列化对象）。 */
type WorkerOutMessage = AnalyzeResultMessage | Record<string, unknown>;

function emit(msg: WorkerOutMessage): void {
  if (typeof process.send === 'function') process.send(msg);
}

interface LayaLike {
  systemOne: (
    state: unknown,
    questions: Record<string, unknown>,
  ) => Promise<{
    answers: Record<
      string,
      | { type: 'choice'; choice: string; confidence: number }
      | { type: 'score'; score: number }
      | { type: 'noul'; noul: number }
    >;
  }>;
  close: () => Promise<void>;
}

let laya: LayaLike | null = null;
let loading: Promise<LayaLike> | null = null;

/** score 档位（0..n-1）→ 0..100 百分比。 */
function levelToPct(score: number, levels: number): number {
  const max = Math.max(1, levels - 1);
  return Math.round((Math.min(Math.max(score, 0), max) / max) * 100);
}

/** score 档位（0..n-1）→ -100..100（情感倾向）。 */
function levelToSentiment(score: number, levels: number): number {
  const pct = levelToPct(score, levels);
  return Math.round(pct * 2 - 100);
}

/** IEEE half (Uint16Array 原始位) → float32。 */
function f16ToF32(h: Uint16Array): Float32Array {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const v = h[i] as number;
    const sign = v & 0x8000 ? -1 : 1;
    const exp = (v >> 10) & 0x1f;
    const frac = v & 0x3ff;
    out[i] =
      exp === 0
        ? sign * 6.103515625e-8 * frac
        : exp === 31
          ? frac
            ? Number.NaN
            : sign * Number.POSITIVE_INFINITY
          : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  return out;
}

/**
 * 加载多语言 Laya。三处与 `@receptron/laya` 自带 `Laya.load` 的默认路径不同，
 * 必须自己组装（它的 load 硬编码了英文 ModernBERT checkpoint 的约定）：
 *   1. special token：英文版查 `[CLS]`/`[SEP]`，多语言 mmBERT 词表是
 *      `<s>`/`</s>`/`<mask>`/`<pad>` —— 语义等价替换（buildSequence 只依赖
 *      槽位语义，与具体符号无关）。
 *   2. fp16 导出的输出是 float16 张量，包只认 Float32Array —— patch
 *      session.run 把 float16 输出转 float32。
 *   3. 多语言导出把 `act_probs` 改名成了 `act_logits`（原始 logit）—— 改名
 *      回来并补 sigmoid 对齐 act_probability 语义。
 */
async function createLaya(modelDir: string): Promise<LayaLike> {
  const { Laya } = requireFn('@receptron/laya') as {
    Laya: abstract new (...args: unknown[]) => LayaLike;
  };
  // onnxruntime / tokenizers 必须解析到 @receptron/laya 同层的实例（版本随它锁）。
  const entry = requireFn.resolve('@receptron/laya') as string;
  const sibling = createRequire(entry.replace(/[/\\]index\.js$/, '/laya.js')) as NodeRequire;
  const ort = sibling('onnxruntime-node') as {
    InferenceSession: {
      create: (
        path: string,
        opts: Record<string, unknown>,
      ) => Promise<{
        run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }>;
    };
    Tensor: new (type: string, data: unknown, dims: readonly number[]) => unknown;
  };
  const { Tokenizer } = sibling('@huggingface/tokenizers') as {
    Tokenizer: new (
      a: unknown,
      b: unknown,
    ) => {
      token_to_id(t: string): number | undefined;
      encode(text: string, opts: { add_special_tokens: boolean }): { ids: number[] };
    };
  };

  const read = (f: string): unknown => JSON.parse(readFileSync(join(modelDir, f), 'utf8'));
  const config = read('laya_config.json');
  const tok = new Tokenizer(read('tokenizer/tokenizer.json'), read('tokenizer/tokenizer_config.json'));
  const idOf = (t: string): number => {
    const v = tok.token_to_id(t);
    if (v === undefined) throw new Error(`special token ${t} missing from tokenizer`);
    return v;
  };
  const ids = {
    cls: idOf('<s>'),
    sep: idOf('</s>'),
    mask: idOf('<mask>'),
    pad: idOf('<pad>'),
    maskTok: '<mask>',
  };

  const session = await ort.InferenceSession.create(join(modelDir, 'laya.onnx'), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  const rawRun = session.run.bind(session);
  session.run = async (feeds: Record<string, unknown>) => {
    const out = await rawRun(feeds);
    const fix = (t: unknown, sigmoid: boolean): unknown => {
      const tensor = t as { type?: string; data?: Uint16Array; dims?: readonly number[] } | undefined;
      if (tensor?.type !== 'float16' || !(tensor.data instanceof Uint16Array)) return t;
      const f = f16ToF32(tensor.data);
      if (sigmoid) for (let i = 0; i < f.length; i++) f[i] = 1 / (1 + Math.exp(-(f[i] ?? 0)));
      return new ort.Tensor('float32', f, tensor.dims ?? [f.length]);
    };
    return {
      ...out,
      logits: fix(out.logits, false),
      act_probs: out.act_probs ?? fix(out.act_logits, true),
    };
  };

  // Laya 的构造器在 d.ts 里标 private（类型层面），运行时组装是官方 load 之外
  // 唯一能带自定义 ids/patch 的入口 —— Reflect.construct 绕过类型限制。
  return Reflect.construct(Laya, [session, tok, config, ids, modelDir]) as LayaLike;
}

async function loadLaya(modelDir: string): Promise<LayaLike> {
  if (laya) return laya;
  if (loading) return loading;
  loading = createLaya(modelDir)
    .then((instance) => {
      laya = instance;
      return instance;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

async function handleAnalyze(id: number, text: string): Promise<void> {
  const engine = await loadLaya(layaModelDir!);
  const state = `私聊消息：「${text}」`;
  const res = await engine.systemOne(state, {
    intent: {
      type: 'choice',
      instructions: '发送这条消息的人的沟通意图是什么？',
      criteria: INTENT_CRITERIA,
    },
    emotion: {
      type: 'choice',
      instructions: '发送者当前的情绪状态最接近哪一种？',
      criteria: EMOTION_CRITERIA,
    },
    intensity: {
      type: 'score',
      instructions: '这条消息情绪的强烈程度？',
      criteria: INTENSITY_LEVELS,
    },
    sentiment: {
      type: 'score',
      instructions: '这条消息的整体情感倾向？',
      criteria: SENTIMENT_LEVELS,
    },
  });
  const intentAns = res.answers.intent;
  const emotionAns = res.answers.emotion;
  const intensityAns = res.answers.intensity;
  const sentimentAns = res.answers.sentiment;
  if (intentAns?.type !== 'choice' || emotionAns?.type !== 'choice') {
    throw new Error('laya answers shape mismatch');
  }
  const out: AnalyzeResultMessage = {
    type: 'result',
    id,
    intent: intentAns.choice in INTENT_CRITERIA ? intentAns.choice : 'other',
    emotion: emotionAns.choice in EMOTION_CRITERIA ? emotionAns.choice : 'neutral',
    intensity:
      intensityAns?.type === 'score' ? levelToPct(intensityAns.score, INTENSITY_LEVELS.length) : 50,
    sentiment:
      sentimentAns?.type === 'score'
        ? levelToSentiment(sentimentAns.score, SENTIMENT_LEVELS.length)
        : 0,
    confidence: Math.round(((intentAns.confidence + emotionAns.confidence) / 2) * 100) / 100,
  };
  emit(out);
}

async function handleMbti(id: number, samples: string[]): Promise<void> {
  const engine = await loadLaya(layaModelDir!);
  const joined = samples
    .slice(-120)
    .map((s) => `「${s}」`)
    .join('\n')
    .slice(0, 8000);
  const res = await engine.systemOne(`以下是某人在私聊里的消息样本：\n${joined}`, MBTI_QUESTIONS);
  const dims: Array<{ key: string; leftPct: number }> = [];
  for (const key of ['EI', 'SN', 'TF', 'JP'] as const) {
    const ans = res.answers[key];
    if (ans?.type !== 'score') continue;
    dims.push({ key, leftPct: levelToPct(ans.score, MBTI_QUESTIONS[key].criteria.length) });
  }
  emit({ type: 'mbti-result', id, dims });
}

let layaModelDir: string | null = null;

process.on(
  'message',
  (msg: {
    type?: string;
    id?: number;
    text?: string;
    samples?: string[];
    modelDir?: string;
    error?: string;
  }) => {
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case 'load': {
        layaModelDir = m.modelDir as string;
        loadLaya(layaModelDir)
          .then(() => emit({ type: 'ready' }))
          .catch((e) => emit({ type: 'load-error', error: String(e) }));
        break;
      }
      case 'analyze': {
        handleAnalyze(m.id as number, m.text as string).catch((e) =>
          emit({ type: 'analyze-error', id: m.id, error: String(e) }),
        );
        break;
      }
      case 'mbti': {
        handleMbti(m.id as number, (m.samples as string[]) ?? []).catch((e) =>
          emit({ type: 'analyze-error', id: m.id, error: String(e) }),
        );
        break;
      }
      case 'close': {
        void laya?.close().finally(() => process.exit(0));
        break;
      }
      default:
        break;
    }
  },
);

process.once('disconnect', () => {
  void laya?.close().finally(() => process.exit(0));
});
