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

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const requireFn = createRequire(__filename);

/** 与 @weq/service 的 INTENT_LABELS / EMOTION_LABELS 键保持一致。 */
const INTENT_CRITERIA: Record<string, string> = {
  question: '提出问题、好奇追问、求科普或寻求答案（如：尊嘟假嘟、细说、怎么搞）',
  request: '请求对方做某事、帮忙或求助',
  greeting: '打招呼、问候、寒暄',
  share: '分享见闻、经历、成果、链接、图片内容',
  praise:
    '夸赞、佩服、惊叹对方或某事很厉害、捧场（含正话反说或夸张惊叹，如：牛逼、666、绝了、给跪了、吓哭了、看傻了、恐怖如斯）',
  vent: '吐槽、抱怨、发泄负面情绪或反语敷衍（如：麻了、丸辣、天塌了、啊对对对、好好好）',
  joke: '开玩笑、玩梗、调侃、发搞笑内容或狂喜大笑（如：笑死、笑哭、蚌埠住了、哈哈哈）',
  plan: '商量、约定或爽快答应要做的事（时间地点安排、包的、冲冲冲）',
  info: '通知、告知事实、同步进展',
  chat: '没有明确目的的日常闲聊、温情互动',
  boast: '炫耀成果、晒抽卡、秀战绩、凡尔赛高光（如：看看我的、自研上线、百万QPS、出金了、满命）',
  flattery:
    '极力吹捧、疯狂打call、捧哏拍马（如：大佬受我一拜、太权威了、仙品细糠、神仙下凡、永远的神）',
  banter:
    '损友调侃、互怼打趣、戏谑开涮（如：就这啊、你小子、损不损啊、差不多得了、典中典、很难评）',
  perfunctory: '敷衍应付、已读乱回、表面顺从反讽（如：啊对对对、行行行、好好好、哦哦、你开心就好）',
  gossip: '围观吃瓜、八卦追问、求料蹲坑（如：尊嘟假嘟、求细说、前排吃瓜、蹲后续、啥情况）',
  coquetry: '软萌撒娇、求助示弱、亲昵讨好（如：呜呜呜好哥哥、带带我嘛、求求你了、要抱抱、嘤嘤嘤）',
  other: '以上都不符合',
};

const EMOTION_CRITERIA: Record<string, string> = {
  joy: '开心、愉快、大笑、觉得好笑（如：哈哈、笑死、笑哭、蚌埠住了）',
  excitement: '兴奋、激动、期待、干劲十足（如：冲冲冲、包的、太期待了）',
  admiration:
    '赞叹、惊叹、佩服、被震撼、觉得太牛逼或太厉害了（含网络夸张修辞如：吓哭了、给跪了、看傻了、头皮发麻、恐怖如斯、太变态了、666、绝了）',
  neutral: '平静、客观陈述、无明显情绪',
  sadness: '低落、难过、失落、委屈',
  anger: '生气、不满、烦躁、阴阳怪气敷衍（如：气死、啊对对对、好好好）',
  anxiety: '真实焦虑、担心、害怕、紧张慌乱',
  affection: '亲昵、撒娇、关心、感动暖心（如：贴贴、抱抱、感动哭了、泪目、awsl）',
  fatigue: '疲惫、倦怠、心累、没精力（如：麻了、燃尽了、累死、困死、躺平）',
  curiosity: '好奇、感兴趣、吃瓜追问（如：尊嘟假嘟、细说、真的假的）',
  shock: '极度震惊、目瞪口呆、瞳孔地震、被深深震撼（如：看傻了、卧槽我人傻了、头皮发麻）',
  aggrieved: '委屈难过、心态受挫、觉得不公（如：太欺负人了、凭什么啊、好委屈、心态崩了）',
  irony: '反讽、阴阳怪气、正话反说、冷嘲（如：呵呵、真是谢谢你、啊对对对、典中典）',
  anticipation: '急切期待、迫不及待、摩拳擦掌（如：急急急、等不及了、坐等更新、什么时候出）',
  embarrassed: '尴尬、社死、脚趾抠地、无地自容（如：尬住了、社死现场、太尴尬了）',
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
function getDependencies() {
  const entry = requireFn.resolve('@receptron/laya') as string;
  const sibling = createRequire(entry.replace(/[/\\]index\.js$/, '/laya.js')) as NodeRequire;
  const ort = sibling('onnxruntime-node') as {
    InferenceSession: {
      create: (
        path: string,
        opts?: Record<string, unknown>,
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
  return { ort, Tokenizer };
}

interface WorkerContextTurn {
  mine?: boolean;
  text?: string;
  gap_sec?: number;
}

interface CommonEngine {
  analyze(
    id: number,
    text: string,
    mine?: boolean,
    context?: WorkerContextTurn[],
    pragmaticHint?: string | null,
  ): Promise<AnalyzeResultMessage>;
  inferMbti(id: number, samples: string[]): Promise<Array<{ key: string; leftPct: number }>>;
  close(): Promise<void>;
}

interface QWeQConfig {
  model_name: string;
  max_length?: number;
  intent_labels: string[];
  emotion_labels: string[];
}

async function createQWeQ(modelDir: string): Promise<CommonEngine> {
  const { ort, Tokenizer } = getDependencies();
  const cfgPath = join(modelDir, 'model_config.json');
  const cfg: QWeQConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));

  const tokJsonPath = existsSync(join(modelDir, 'tokenizer', 'tokenizer.json'))
    ? join(modelDir, 'tokenizer', 'tokenizer.json')
    : join(modelDir, 'tokenizer.json');
  const tokConfigPath = existsSync(join(modelDir, 'tokenizer', 'tokenizer_config.json'))
    ? join(modelDir, 'tokenizer', 'tokenizer_config.json')
    : join(modelDir, 'tokenizer_config.json');

  const tok = new Tokenizer(
    JSON.parse(readFileSync(tokJsonPath, 'utf8')),
    JSON.parse(readFileSync(tokConfigPath, 'utf8')),
  );

  const session = await ort.InferenceSession.create(join(modelDir, 'model.onnx'), {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });

  const analyze: CommonEngine['analyze'] = async (id, text, _mine, context, pragmaticHint) => {
    const parts: string[] = [];
    if (Array.isArray(context) && context.length > 0) {
      for (const turn of context.slice(-4)) {
        if (!turn?.text?.trim()) continue;
        const speaker = turn.mine ? '我' : '对方';
        const gap = typeof turn.gap_sec === 'number' ? turn.gap_sec : 30;
        let tag = '刚刚';
        if (gap <= 60) tag = '刚刚';
        else if (gap <= 300) tag = '几分钟前';
        else if (gap <= 600) tag = '十分钟内';
        else tag = '久远';
        parts.push(`上文[${tag}]: ${speaker}: ${turn.text.trim().slice(0, 120)}`);
      }
    }
    const ctxStr = parts.join(' | ');
    let formatted = ctxStr ? `${ctxStr} [SEP] 消息: ${text.trim()}` : `消息: ${text.trim()}`;
    if (typeof pragmaticHint === 'string' && pragmaticHint.trim().length > 0) {
      formatted += ` (语境: ${pragmaticHint.trim()})`;
    }

    const maxLen = cfg.max_length ?? 128;
    const encoded = tok.encode(formatted, { add_special_tokens: true });
    const ids = encoded.ids.slice(0, maxLen);
    const mask = new Array(ids.length).fill(1);
    const typeIds = new Array(ids.length).fill(0);
    while (ids.length < maxLen) {
      ids.push(0);
      mask.push(0);
      typeIds.push(0);
    }

    const feeds = {
      input_ids: new ort.Tensor('int64', new BigInt64Array(ids.map(BigInt)), [1, maxLen]),
      attention_mask: new ort.Tensor('int64', new BigInt64Array(mask.map(BigInt)), [1, maxLen]),
      token_type_ids: new ort.Tensor('int64', new BigInt64Array(typeIds.map(BigInt)), [1, maxLen]),
    };

    const out = await session.run(feeds);
    const intentLogits = Array.from((out.intent_logits as { data: Float32Array }).data);
    const emotionLogits = Array.from((out.emotion_logits as { data: Float32Array }).data);

    const maxIntent = Math.max(...intentLogits);
    const expIntent = intentLogits.map((v) => Math.exp(v - maxIntent));
    const sumIntent = expIntent.reduce((a, b) => a + b, 0);
    const intentProb = (expIntent[intentLogits.indexOf(maxIntent)] ?? 1) / (sumIntent || 1);

    const maxEmotion = Math.max(...emotionLogits);
    const expEmotion = emotionLogits.map((v) => Math.exp(v - maxEmotion));
    const sumEmotion = expEmotion.reduce((a, b) => a + b, 0);
    const emotionProb = (expEmotion[emotionLogits.indexOf(maxEmotion)] ?? 1) / (sumEmotion || 1);

    const bestIntentIdx = intentLogits.indexOf(maxIntent);
    const bestEmotionIdx = emotionLogits.indexOf(maxEmotion);

    const intent = cfg.intent_labels[bestIntentIdx] ?? 'other';
    const emotion = cfg.emotion_labels[bestEmotionIdx] ?? 'neutral';
    const rawIntensity = Number(
      Array.from((out.intensity as { data: Float32Array }).data)[0] ?? 50,
    );
    const rawSentiment = Number(Array.from((out.sentiment as { data: Float32Array }).data)[0] ?? 0);

    return {
      type: 'result',
      id,
      intent: intent in INTENT_CRITERIA ? intent : 'other',
      emotion: emotion in EMOTION_CRITERIA ? emotion : 'neutral',
      intensity: Math.min(100, Math.max(0, Math.round(rawIntensity))),
      sentiment: Math.min(100, Math.max(-100, Math.round(rawSentiment))),
      confidence: Math.round(((intentProb + emotionProb) / 2) * 100) / 100,
    };
  };

  const inferMbti: CommonEngine['inferMbti'] = async (_id, samples) => {
    const subset = samples.slice(-30);
    let extrovertScore = 0;
    let intuitionScore = 0;
    let feelingScore = 0;
    let perceivingScore = 0;

    for (const s of subset) {
      if (!s.trim()) continue;
      const res = await analyze(0, s);
      if (['greeting', 'joke', 'gossip', 'share', 'flattery', 'boast'].includes(res.intent)) {
        extrovertScore += 1;
      } else if (['info', 'perfunctory', 'other'].includes(res.intent)) {
        extrovertScore -= 0.5;
      }

      if (['chat', 'joke', 'gossip'].includes(res.intent)) {
        intuitionScore += 1;
      } else if (['plan', 'info', 'request'].includes(res.intent)) {
        intuitionScore -= 1;
      }

      if (['admiration', 'joy', 'affection', 'aggrieved', 'anxiety'].includes(res.emotion)) {
        feelingScore += 1;
      } else if (['neutral'].includes(res.emotion) || ['info', 'plan'].includes(res.intent)) {
        feelingScore -= 1;
      }

      if (['plan', 'request'].includes(res.intent)) {
        perceivingScore -= 1;
      } else if (['joke', 'banter', 'gossip', 'chat'].includes(res.intent)) {
        perceivingScore += 1;
      }
    }

    const n = Math.max(1, subset.length);
    const toPct = (score: number) => Math.min(95, Math.max(5, Math.round(50 + (score / n) * 40)));

    return [
      { key: 'EI', leftPct: toPct(extrovertScore) },
      { key: 'SN', leftPct: 100 - toPct(intuitionScore) },
      { key: 'TF', leftPct: 100 - toPct(feelingScore) },
      { key: 'JP', leftPct: 100 - toPct(perceivingScore) },
    ];
  };

  return {
    analyze,
    inferMbti,
    async close() {
      // ONNX session cleaned up on process exit
    },
  };
}

async function createLaya(modelDir: string): Promise<LayaLike> {
  const layaMod = (await import('@receptron/laya')) as unknown as {
    Laya: abstract new (...args: unknown[]) => LayaLike;
  };
  const { Laya } = layaMod;
  const { ort, Tokenizer } = getDependencies();

  const read = (f: string): unknown => JSON.parse(readFileSync(join(modelDir, f), 'utf8'));
  const config = read('laya_config.json');
  const tok = new Tokenizer(
    read('tokenizer/tokenizer.json'),
    read('tokenizer/tokenizer_config.json'),
  );
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
      const tensor = t as
        | { type?: string; data?: Uint16Array; dims?: readonly number[] }
        | undefined;
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

  return Reflect.construct(Laya, [session, tok, config, ids, modelDir]) as LayaLike;
}

async function createLayaEngine(modelDir: string): Promise<CommonEngine> {
  const layaInstance = await createLaya(modelDir);
  return {
    async analyze(id, text, mine, context, pragmaticHint) {
      const parts: string[] = [];
      if (Array.isArray(context) && context.length > 0) {
        const lines = context
          .filter((c) => c && typeof c.text === 'string' && c.text.trim().length > 0)
          .slice(-4)
          .map((c) => `${c.mine ? '我' : '对方'}：「${c.text!.trim().slice(0, 160)}」`);
        if (lines.length > 0) {
          parts.push(`上文对话：\n${lines.join('\n')}`);
        }
      }
      const speaker = mine === true ? '我' : '对方';
      parts.push(`当前待分析消息（${speaker}）：「${text}」`);
      if (typeof pragmaticHint === 'string' && pragmaticHint.trim().length > 0) {
        parts.push(`语境与网络用语提示：${pragmaticHint.trim()}`);
      }
      const state = parts.join('\n');
      const res = await layaInstance.systemOne(state, {
        intent: {
          type: 'choice',
          instructions: '结合上下文语境，发送当前这条消息的人的真实沟通意图是什么？',
          criteria: INTENT_CRITERIA,
        },
        emotion: {
          type: 'choice',
          instructions:
            '结合上下文语境与中文网络用语习惯（注意区分字面恐惧/哭泣与夸张式赞叹/笑哭），发送者当前真实的情绪状态最接近哪一种？',
          criteria: EMOTION_CRITERIA,
        },
        intensity: {
          type: 'score',
          instructions: '这条消息情绪的强烈程度？',
          criteria: INTENSITY_LEVELS,
        },
        sentiment: {
          type: 'score',
          instructions: '结合语境，这条消息的真实整体情感倾向？（夸赞/惊叹/玩梗大笑为积极）',
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
      return {
        type: 'result',
        id,
        intent: intentAns.choice in INTENT_CRITERIA ? intentAns.choice : 'other',
        emotion: emotionAns.choice in EMOTION_CRITERIA ? emotionAns.choice : 'neutral',
        intensity:
          intensityAns?.type === 'score'
            ? levelToPct(intensityAns.score, INTENSITY_LEVELS.length)
            : 50,
        sentiment:
          sentimentAns?.type === 'score'
            ? levelToSentiment(sentimentAns.score, SENTIMENT_LEVELS.length)
            : 0,
        confidence: Math.round(((intentAns.confidence + emotionAns.confidence) / 2) * 100) / 100,
      };
    },

    async inferMbti(_id, samples) {
      const joined = samples
        .slice(-120)
        .map((s) => `「${s}」`)
        .join('\n')
        .slice(0, 8000);
      const res = await layaInstance.systemOne(
        `以下是某人在私聊里的消息样本：\n${joined}`,
        MBTI_QUESTIONS,
      );
      const dims: Array<{ key: string; leftPct: number }> = [];
      for (const key of ['EI', 'SN', 'TF', 'JP'] as const) {
        const ans = res.answers[key];
        if (ans?.type !== 'score') continue;
        dims.push({ key, leftPct: levelToPct(ans.score, MBTI_QUESTIONS[key].criteria.length) });
      }
      return dims;
    },

    async close() {
      await layaInstance.close();
    },
  };
}

let activeEngine: CommonEngine | null = null;
let loadingEngine: Promise<CommonEngine> | null = null;

async function loadEngine(modelDir: string): Promise<CommonEngine> {
  if (activeEngine) return activeEngine;
  if (loadingEngine) return loadingEngine;
  loadingEngine = (async () => {
    if (
      existsSync(join(modelDir, 'model.onnx')) &&
      existsSync(join(modelDir, 'model_config.json'))
    ) {
      const engine = await createQWeQ(modelDir);
      activeEngine = engine;
      return engine;
    }
    const engine = await createLayaEngine(modelDir);
    activeEngine = engine;
    return engine;
  })().finally(() => {
    loadingEngine = null;
  });
  return loadingEngine;
}

let currentModelDir: string | null = null;

async function handleAnalyze(
  id: number,
  text: string,
  mine?: boolean,
  context?: WorkerContextTurn[],
  pragmaticHint?: string | null,
): Promise<void> {
  const engine = await loadEngine(currentModelDir!);
  const out = await engine.analyze(id, text, mine, context, pragmaticHint);
  emit(out);
}

async function handleMbti(id: number, samples: string[]): Promise<void> {
  const engine = await loadEngine(currentModelDir!);
  const dims = await engine.inferMbti(id, samples);
  emit({ type: 'mbti-result', id, dims });
}

process.on(
  'message',
  (msg: {
    type?: string;
    id?: number;
    text?: string;
    mine?: boolean;
    context?: WorkerContextTurn[];
    pragmaticHint?: string | null;
    samples?: string[];
    modelDir?: string;
    error?: string;
  }) => {
    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case 'load': {
        currentModelDir = m.modelDir as string;
        loadEngine(currentModelDir)
          .then(() => emit({ type: 'ready' }))
          .catch((e) => emit({ type: 'load-error', error: String(e) }));
        break;
      }
      case 'analyze': {
        handleAnalyze(
          m.id as number,
          m.text as string,
          m.mine as boolean | undefined,
          m.context as WorkerContextTurn[] | undefined,
          m.pragmaticHint as string | null | undefined,
        ).catch((e) => emit({ type: 'analyze-error', id: m.id, error: String(e) }));
        break;
      }
      case 'mbti': {
        handleMbti(m.id as number, (m.samples as string[]) ?? []).catch((e) =>
          emit({ type: 'analyze-error', id: m.id, error: String(e) }),
        );
        break;
      }
      case 'close': {
        void activeEngine?.close().finally(() => process.exit(0));
        break;
      }
      default:
        break;
    }
  },
);

process.once('disconnect', () => {
  void activeEngine?.close().finally(() => process.exit(0));
});
