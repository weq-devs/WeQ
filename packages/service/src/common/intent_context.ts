export const DEFAULT_ANALYSIS_CONTEXT_MESSAGES = 4;
// 推荐窗口不含当前消息；默认保留 30 条上文，共 31 条消息。
export const DEFAULT_SUGGESTION_CONTEXT_MESSAGES = 30;
export const MAX_INTENT_CONTEXT_MESSAGES = 100;
export const DEFAULT_SUGGESTION_HISTORY_LIMIT = 500;
export const MAX_SUGGESTION_HISTORY_LIMIT = 10000;

export function isIntentContextCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_INTENT_CONTEXT_MESSAGES
  );
}

/** 业务可调量集中定义，界面、输入校验与旧配置默认值共用。 */
export const INTENT_TUNING = {
  analysisContextMessages: {
    group: 'analysis',
    label: '意图感知上文（条）',
    ariaLabel: '意图感知上文条数',
    default: DEFAULT_ANALYSIS_CONTEXT_MESSAGES,
    min: 0,
    max: MAX_INTENT_CONTEXT_MESSAGES,
  },
  suggestionContextMessages: {
    group: 'suggestions',
    label: '推荐回复上文（条）',
    ariaLabel: '推荐回复上文条数',
    default: DEFAULT_SUGGESTION_CONTEXT_MESSAGES,
    min: 0,
    max: MAX_INTENT_CONTEXT_MESSAGES,
  },
  analysisTemperature: {
    group: 'analysis',
    label: '意图感知温度',
    default: 0.2,
    min: 0,
    max: 2,
    step: 0.1,
  },
  suggestionTemperature: {
    group: 'suggestions',
    label: '推荐回复温度',
    default: 0.7,
    min: 0,
    max: 2,
    step: 0.1,
  },
  suggestionCount: { group: 'suggestions', label: '推荐候选数量上限', default: 3, min: 1, max: 5 },
  suggestionTargetChars: {
    group: 'suggestions',
    label: '推荐目标长度（字）',
    default: 40,
    min: 5,
    max: 200,
  },
  profileTemperature: {
    group: 'profile',
    label: '画像推断温度',
    default: 0.3,
    min: 0,
    max: 2,
    step: 0.1,
  },
  profileApiTimeoutSeconds: {
    group: 'profile',
    label: '画像 API 请求超时（秒）',
    default: 300,
    min: 5,
    max: 300,
  },
  profileApiCooldownSeconds: {
    group: 'profile',
    label: '画像 API 失败冷却（秒）',
    default: 30,
    min: 0,
    max: 300,
  },
  profileDecayDays: {
    group: 'profile',
    label: '情绪统计衰减时长（天）',
    default: 14,
    min: 1,
    max: 90,
  },
  profileModelTopics: { group: 'profile', label: '模型推断话题上限', default: 8, min: 1, max: 30 },
  profileCacheSeconds: {
    group: 'profile',
    label: '画像读取缓存（秒）',
    default: 60,
    min: 0,
    max: 600,
  },
  backfillMessages: {
    group: 'analysis',
    label: '自动补齐范围（条）',
    default: 60,
    min: 20,
    max: 1000,
  },
  apiBatchMessages: {
    group: 'analysis',
    label: '每次 API 请求目标数（条）',
    default: 12,
    min: 1,
    max: 50,
  },
  contextGapMinutes: {
    group: 'analysis',
    label: '上文相邻间隔上限（分钟）',
    default: 8,
    min: 1,
    max: 120,
  },
  contextSpanMinutes: {
    group: 'analysis',
    label: '上文追溯跨度（分钟）',
    default: 15,
    min: 1,
    max: 1440,
  },
  cacheEntries: {
    group: 'advanced',
    label: '每会话分析缓存上限（条）',
    default: 2000,
    min: 100,
    max: 10000,
  },
  apiTimeoutSeconds: {
    group: 'advanced',
    label: 'API 请求超时（秒）',
    default: 30,
    min: 5,
    max: 120,
  },
  apiCooldownSeconds: {
    group: 'advanced',
    label: 'API 失败冷却（秒）',
    default: 30,
    min: 0,
    max: 300,
  },
  suggestionCacheSeconds: {
    group: 'suggestions',
    label: '同一消息推荐缓存（秒）',
    default: 90,
    min: 0,
    max: 600,
  },
  suggestionHistoryLimit: {
    group: 'suggestions',
    label: '每会话保留的推荐轮数',
    default: DEFAULT_SUGGESTION_HISTORY_LIMIT,
    min: 0,
    max: MAX_SUGGESTION_HISTORY_LIMIT,
  },
  profileMessages: {
    group: 'profile',
    label: '画像统计消息范围（条）',
    default: 800,
    min: 50,
    max: 5000,
  },
  profileSamples: {
    group: 'profile',
    label: '模型推断采样上限（条）',
    default: 120,
    min: 10,
    max: 1000,
  },
  profileMinSamples: {
    group: 'profile',
    label: '模型推断最少样本（条）',
    default: 8,
    min: 1,
    max: 1000,
  },
  profileGapMinutes: {
    group: 'profile',
    label: '画像会话切分间隔（分钟）',
    default: 30,
    min: 1,
    max: 240,
  },
  profileTrendDays: { group: 'profile', label: '趋势展示天数', default: 14, min: 1, max: 90 },
  profileTopicLimit: { group: 'profile', label: '画像话题数量上限', default: 10, min: 1, max: 30 },
} as const;

export type IntentTuningKey = keyof typeof INTENT_TUNING;
export type IntentTuning = Record<IntentTuningKey, number>;
export const INTENT_TUNING_HELP: Partial<Record<IntentTuningKey, string>> = {
  analysisContextMessages: '当前消息之前的语境，不是待分析消息数量；0 表示不附带上文。',
  suggestionContextMessages: '不含当前消息；0 表示只依据当前消息。',
  backfillMessages: '检查最近消息并补齐缺少的分析，已有有效缓存不会重复处理。',
  apiBatchMessages: '单次请求实际分析的目标数，与补齐范围、每条上文数量独立。',
  apiCooldownSeconds: '失败后的等待时长；0 表示不额外冷却，不代表自动重发。',
  cacheEntries: '仅限制生成的分析缓存，不改动原始消息。',
  suggestionCacheSeconds: '同一消息复用候选的时长；0 表示不复用。',
  suggestionHistoryLimit: '每轮包含一次生成的全部候选；0 表示停止新增保存，已有历史保留。',
  suggestionCount: '生成式与回退候选的数量上限；可用内容不足时可能少于此数量。',
  suggestionTargetChars: '作为生成提示，不强制截断模型回复。',
  profileSamples: '不超过统计消息范围；只将选中的对方文本交给推断模型。',
  profileMinSamples: '不超过采样上限；按可用的对方文本计数，不依赖意图分析结果。',
  profileTopicLimit: '控制画像中显示的话题数。',
  profileModelTopics: '控制向模型请求的话题数，不是统计话题总数。',
  profileCacheSeconds: '画像读取结果的复用时长；0 表示不复用，不会增加后台轮询。',
};
export const INTENT_TUNING_KEYS = Object.keys(INTENT_TUNING) as IntentTuningKey[];
export const DEFAULT_INTENT_TUNING = Object.fromEntries(
  INTENT_TUNING_KEYS.map((key) => [key, INTENT_TUNING[key].default]),
) as IntentTuning;

export function isIntentTuningValue(key: IntentTuningKey, value: unknown): value is number {
  const rule = INTENT_TUNING[key];
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    ('step' in rule || Number.isSafeInteger(value)) &&
    value >= rule.min &&
    value <= rule.max
  );
}

export function normalizeIntentTuning(input: Partial<IntentTuning>): IntentTuning {
  return Object.fromEntries(
    INTENT_TUNING_KEYS.map((key) => [
      key,
      isIntentTuningValue(key, input[key]) ? input[key] : INTENT_TUNING[key].default,
    ]),
  ) as IntentTuning;
}

export const DEFAULT_SUGGESTION_FALLBACK_TEXTS: readonly string[] = [
  '稍等我确认一下跟你说~',
  '这个我还真知道，展开跟你讲讲',
  '哈哈怎么突然问起这个？',
  '没问题，包在我身上！',
  '好嘞，我这就去弄，弄好叫你',
  '手头稍微有点事，晚几分钟帮你看可以吗？',
  '包的！直接冲，几点集合？',
  '可以呀，算我一个~',
  '我先看下时间安排，待会给你准信',
  '在的在的，刚忙完~',
  '哈哈早呀，今天心情不错嘛',
  '咋啦，有什么好玩的事？',
  '哈哈低调低调，还得靠大家捧场~',
  '被你夸得我都要飘了哈哈哈',
  '还得是你懂行！下次带你一起整',
  '卧槽太强了吧！给大佬跪了',
  '羡慕哭了，分我一点欧气！',
  '牛哇，这波必须请客庆祝一下',
  '抱抱你，别太往心里去，真的辛苦了',
  '这也太欺负人了吧，换我也得气死！',
  '不气不气，待会吃点好的转换下心情',
  '辛苦啦！赶紧歇一歇回回血',
  '打工人太难了，今晚必须早点睡',
  '走，搞杯奶茶续命！',
  '懂你，这事换谁遇到都得血压飙升',
  '太离谱了吧，后来怎么解决的？',
  '摸摸头，消消气，别拿别人的错误惩罚自己',
  '哈哈哈哈笑死我了，你真是个人才',
  '你小子夺笋啊，等着瞧！',
  '蚌埠住了，今天功德又被你笑没了',
  '搬好小板凳了，快展开讲讲！',
  '尊嘟假嘟？还有这种操作？',
  '这瓜保熟吗哈哈，细说后续',
  '好啦好啦，都依你行了吧~',
  '摸摸头，拿你没办法，走起！',
  '哈哈少来这套，说吧想要啥？',
  '哈哈看破不说破，先不打扰你忙啦',
  '好家伙，这敷衍得也太明显了吧😂',
  '行嘞，有空再聊~',
  '收到！太及时了，多谢分享~',
  '哇看着很不错诶，回头我也试试',
  '了解，我记一下！',
  '哈哈确实，我也这么觉得',
  '展开说说？后来呢',
  '好的呀，没问题~',
];
export const MAX_SUGGESTION_FALLBACK_TEXTS = 100;
export const MAX_SUGGESTION_FALLBACK_LENGTH = 500;

export function validateSuggestionFallbackTexts(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SUGGESTION_FALLBACK_TEXTS)
    throw new Error('回退内容最多 100 条');
  const texts = value.map((text: unknown) => {
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.trim().length > MAX_SUGGESTION_FALLBACK_LENGTH
    )
      throw new Error('每条回退内容须为 1–500 字符');
    return text.trim();
  });
  if (new Set(texts).size !== texts.length) throw new Error('回退内容不能重复');
  return texts;
}

export function sampleSuggestionFallback(texts: readonly string[], count: number): string[] {
  const pool = [...texts];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, count);
}
