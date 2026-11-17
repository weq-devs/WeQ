import { useState } from 'react';
import type { UsageStats } from '../../src/renderer/src/views/agentlab/UsagePanel';

const now = Date.parse('2026-11-13T08:30:00+08:00');
const kind = new URLSearchParams(location.search).get('case');
export const client = {};
function data(period: UsageStats['period']): UsageStats {
  const bucket = { calls: 10, tokens: 2000, unknownCalls: 2 };
  const unknown = kind === 'unknown';
  return {
    period,
    range: { since: period === 'retained' ? null : now - 6 * 86400_000, until: now },
    ledgers: [
      {
        source: 'account',
        retainedCalls: 5000,
        limit: 5000,
        atCapacity: true,
        firstRecordAt: now - 20 * 86400_000,
        lastRecordAt: now,
      },
      {
        source: 'global',
        retainedCalls: 123,
        limit: 5000,
        atCapacity: false,
        firstRecordAt: now - 15 * 86400_000,
        lastRecordAt: now,
      },
    ],
    totalTokens: unknown ? 0 : 187654,
    totalCalls: kind === 'empty' ? 0 : 47,
    accountCalls: 40,
    globalCalls: 7,
    knownCalls: unknown ? 0 : 35,
    unknownCalls: unknown ? 47 : 12,
    promptUnknownCalls: unknown ? 47 : 12,
    completionUnknownCalls: unknown ? 47 : 15,
    failedCalls: 3,
    cancelledCalls: 2,
    pendingCalls: 3,
    interruptedCalls: 1,
    promptTokens: unknown ? 0 : 150000,
    completionTokens: unknown ? 0 : 37654,
    byScope: [],
    byCategory: [
      {
        category: 'clone',
        label: '克隆会话',
        calls: 20,
        tokens: 100000,
        unknownCalls: 5,
        features: [
          { feature: 'expressions', label: '表达风格库', calls: 6, tokens: 20000, unknownCalls: 1 },
          {
            feature: 'deep-profile-chunk',
            label: '深层画像分块',
            calls: 5,
            tokens: 40000,
            unknownCalls: 1,
          },
          { feature: 'chat', label: '对话生成', calls: 5, tokens: 30000, unknownCalls: 1 },
          {
            feature: 'image-analysis',
            label: '图片分析',
            calls: 3,
            tokens: 10000,
            unknownCalls: 1,
          },
          { feature: 'tts-synthesis', label: '语音合成', calls: 1, tokens: 0, unknownCalls: 1 },
        ],
      },
      {
        category: 'assistant',
        label: 'WeQ 助手',
        calls: 12,
        tokens: 60000,
        unknownCalls: 2,
        features: [
          { feature: 'assistant', label: '对话生成', calls: 8, tokens: 50000, unknownCalls: 1 },
          {
            feature: 'assistant-title',
            label: '会话标题',
            calls: 2,
            tokens: 4000,
            unknownCalls: 0,
          },
          { feature: 'image-analysis', label: '图片分析', calls: 2, tokens: 6000, unknownCalls: 1 },
        ],
      },
      {
        category: 'settings',
        label: '模型与识别设置',
        calls: 4,
        tokens: 12000,
        unknownCalls: 1,
        features: [
          {
            feature: 'capability-test',
            label: '能力检测',
            calls: 4,
            tokens: 12000,
            unknownCalls: 1,
          },
        ],
      },
      {
        category: 'intent',
        label: '意图感知',
        calls: 4,
        tokens: 8000,
        unknownCalls: 1,
        features: [
          {
            feature: 'intent-analysis',
            label: '意图分析',
            calls: 4,
            tokens: 8000,
            unknownCalls: 1,
          },
        ],
      },
      {
        category: 'suggestions',
        label: '推荐回复',
        calls: 4,
        tokens: 7654,
        unknownCalls: 0,
        features: [
          {
            feature: 'reply-suggestion',
            label: '回复生成',
            calls: 4,
            tokens: 7654,
            unknownCalls: 0,
          },
        ],
      },
      {
        category: 'speech',
        label: '语音服务',
        calls: 3,
        tokens: 0,
        unknownCalls: 3,
        features: [
          { feature: 'tts-synthesis', label: '语音合成', calls: 3, tokens: 0, unknownCalls: 3 },
        ],
      },
    ].map((row) => ({
      ...row,
      tokens: unknown ? 0 : row.tokens,
      unknownCalls: unknown ? row.calls : row.unknownCalls,
      features: row.features.map((child) => ({
        ...child,
        tokens: unknown ? 0 : child.tokens,
        unknownCalls: unknown ? child.calls : child.unknownCalls,
      })),
    })),
    byFeature: [
      'assistant',
      'assistant-title',
      'capability-test',
      'intent-analysis',
      'reply-suggestion',
      'assistant-image',
      'tts-synthesis',
    ].map((feature) => ({
      ...bucket,
      feature,
      tokens: unknown ? 0 : bucket.tokens,
      unknownCalls: unknown ? 10 : 2,
    })),
    byPersona: kind === 'clones' ? [{ ...bucket, personaId: 'deleted-clone' }] : [],
    byModel: [
      {
        key: 'a',
        providerId: 'api-primary',
        providerName: '同名配置',
        model: 'synthetic-reasoning-model',
        providerKind: 'model',
        ...bucket,
      },
      {
        key: 'b',
        providerId: 'api-secondary-with-a-long-configuration-identifier',
        providerName: '同名配置',
        model: 'synthetic-model-with-a-very-long-name-that-must-wrap-on-mobile',
        providerKind: 'model',
        ...bucket,
      },
      {
        key: 'old',
        providerId: null,
        providerName: null,
        model: 'legacy-model',
        providerKind: 'model',
        ...bucket,
      },
      {
        key: 'tts',
        providerId: 'voice',
        providerName: '合成语音',
        model: 'synthetic-voice',
        providerKind: 'tts',
        ...bucket,
        unknownCalls: 10,
        tokens: 0,
      },
    ].map((row) => ({
      ...row,
      tokens: unknown ? 0 : row.tokens,
      unknownCalls: unknown ? row.calls : row.unknownCalls,
    })) as UsageStats['byModel'],
    byDay: Array.from({ length: period === '7d' ? 7 : 30 }, (_, i) => ({
      day: `2026-11-${String(i + 1).padStart(2, '0')}`,
      calls: (i % 3) * 2,
      tokens: unknown ? 0 : (i % 3) * 1200,
      unknownCalls: 1,
    })),
    byHour: Array.from({ length: 24 }, (_, i) => ({
      hour: `${String(i).padStart(2, '0')}:00`,
      calls: i % 4,
      tokens: unknown ? 0 : (i % 4) * 1500,
      unknownCalls: 1,
    })),
  };
}
export const trpc = {
  account: {
    getAgentLabTokenStats: {
      useQuery(input: { period: UsageStats['period'] }) {
        const [retried, setRetried] = useState(false);
        const error = (kind === 'error' || kind === 'stale') && !retried;
        return {
          data: kind === 'loading' || (error && kind === 'error') ? undefined : data(input.period),
          isLoading: kind === 'loading',
          isFetching: kind === 'loading',
          isError: error,
          error: error ? { message: '合成读取失败' } : null,
          refetch: async () => setRetried(true),
        };
      },
    },
    listAgentLabPersonas: { useQuery: () => ({ data: [] }) },
  },
};
