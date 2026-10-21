export const DEFAULT_ANALYSIS_CONTEXT_MESSAGES = 4;
// 旧推荐窗口共 24 条，扣除当前消息后保持 23 条上文。
export const DEFAULT_SUGGESTION_CONTEXT_MESSAGES = 23;
export const MAX_INTENT_CONTEXT_MESSAGES = 100;

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
    default: 300,
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
  suggestionCount: '生成式候选的数量上限；规则兜底可能少于此数量。',
  suggestionTargetChars: '作为生成提示，不强制截断模型回复。',
  profileSamples: '不超过统计消息范围；只将选中的对方文本交给推断模型。',
  profileMinSamples: '不超过采样上限；跟随模式按已分析消息计数，独立模型按可用文本计数。',
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
