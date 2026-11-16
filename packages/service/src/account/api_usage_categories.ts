import type { AgentLabUsage } from '@weq/agentlab';

const CATEGORY_LABELS = {
  clone: '克隆会话',
  assistant: 'WeQ 助手',
  intent: '意图感知',
  suggestions: '推荐回复',
  profile: '互动画像',
  settings: '模型与识别设置',
  recognition: '图片识别',
  speech: '语音服务',
  other: '其他 API',
} as const;
type Category = keyof typeof CATEGORY_LABELS;

const BUSINESS_SCOPES: Record<string, Category> = {
  build: 'clone',
  chat: 'clone',
  cloneChat: 'clone',
  cloneTraining: 'clone',
  'cloneChat-image': 'clone',
  'cloneTraining-image': 'clone',
  assistant: 'assistant',
  'assistant-image': 'assistant',
  intent: 'intent',
  'intent-analysis': 'intent',
  'intent-image': 'intent',
  suggestions: 'suggestions',
  'reply-suggestion': 'suggestions',
  'suggestions-image': 'suggestions',
  profile: 'profile',
  'intent-profile': 'profile',
  'profile-image': 'profile',
};

const FEATURES: Record<string, readonly [Category, string]> = {
  build: ['clone', '构建克隆（未细分）'],
  chat: ['clone', '对话生成'],
  assistant: ['assistant', '对话生成'],
  'assistant-title': ['assistant', '会话标题'],
  'assistant-summary': ['assistant', '上下文摘要'],
  'intent-analysis': ['intent', '意图分析'],
  'intent-profile': ['profile', '画像提炼'],
  'reply-suggestion': ['suggestions', '回复生成'],
  'connection-test': ['settings', '连接测试'],
  'capability-test': ['settings', '能力检测'],
  'tts-test': ['settings', '语音测试'],
  'clone-name': ['clone', '克隆体起名'],
  'profile-extract': ['clone', '画像提炼'],
  'profile-card': ['clone', '画像卡'],
  'deep-profile-chunk': ['clone', '深层画像分块'],
  'deep-profile-merge': ['clone', '深层画像合并'],
  'dialogue-samples': ['clone', '对话样本'],
  expressions: ['clone', '表达风格库'],
  'style-variants': ['clone', '备用表达风格'],
  'memory-distill': ['clone', '记忆蒸馏'],
  'interaction-sentiment': ['clone', '关系情感打分'],
  'speak-decision': ['clone', '发言决策'],
  reflection: ['clone', '对话反思'],
  'voice-scenario': ['clone', '语音场景总结'],
  'sticker-description': ['clone', '表情解读'],
  'image-analysis': ['recognition', '图片分析'],
  'tts-synthesis': ['speech', '语音合成'],
  tts: ['speech', '语音服务（未细分）'],
  embedding: ['other', '向量检索与索引'],
  other: ['other', '未细分用途'],
};

const FEATURE_ALIASES: Record<string, string> = {
  克隆体起名: 'clone-name',
  画像卡: 'profile-card',
  深层画像分块: 'deep-profile-chunk',
  深层画像合并: 'deep-profile-merge',
  对话样本: 'dialogue-samples',
  表达风格库: 'expressions',
  备用表达风格: 'style-variants',
  记忆蒸馏: 'memory-distill',
  关系情感打分: 'interaction-sentiment',
  发言决策: 'speak-decision',
  对话反思: 'reflection',
  'assistant-image': 'image-analysis',
  'cloneChat-image': 'image-analysis',
  'cloneTraining-image': 'image-analysis',
  'intent-image': 'image-analysis',
  'suggestions-image': 'image-analysis',
  'profile-image': 'image-analysis',
  cloneChat: 'chat',
  cloneTraining: 'build',
};

function lookup<T>(values: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(values, key) ? values[key] : undefined;
}

/** 只在读取时归类旧记录；业务来源优先于共用能力，未知用途保留原名。 */
export function classifyApiUsage(
  record: Pick<AgentLabUsage, 'feature' | 'kind'> & { scope: string },
) {
  const raw = record.feature || record.scope;
  const purpose =
    !record.feature && record.kind !== 'chat'
      ? record.kind === 'vision'
        ? 'image-analysis'
        : record.kind === 'speech'
          ? 'tts-synthesis'
          : 'embedding'
      : raw;
  const feature =
    lookup(FEATURE_ALIASES, purpose) ??
    (/^深层画像\s+\d+\/\d+$/.test(purpose) ? 'deep-profile-chunk' : purpose);
  const definition = lookup(FEATURES, feature);
  const category =
    lookup(BUSINESS_SCOPES, record.scope) ??
    lookup(BUSINESS_SCOPES, raw) ??
    definition?.[0] ??
    'other';
  return {
    category,
    categoryLabel: CATEGORY_LABELS[category],
    feature,
    featureLabel: definition?.[1] ?? raw,
  };
}
