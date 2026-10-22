import type { AgentLabPersona } from '@weq/agentlab';

export function makeBackupPersona(): AgentLabPersona {
  return {
    id: 'synthetic-persona',
    ownerId: '10001',
    name: '合成克隆',
    sourceKind: 'c2c',
    sourceId: 'u_synthetic',
    sourceTitle: '合成来源',
    models: { chat: { providerId: 'synthetic-provider', model: 'synthetic-model' } },
    profile: {
      card: {
        tone: '合成语气',
        personalityTraits: [],
        catchphrases: [],
        punctuationStyle: '',
        addressing: '',
        topics: [],
      },
      deep: { facts: [], relationship: '', reactionPatterns: [], boundaries: [], sharedEvents: [] },
      styleSummary: '合成风格',
      topTerms: [],
      voiceRatio: 0,
      voiceUsageSummary: '',
      relationshipSummary: '',
      extractedByLlm: false,
    },
    fewShots: [],
    expressions: [],
    stickers: [],
    systemFaces: [],
    stats: {
      sourceMessageCount: 1,
      friendMessageCount: 1,
      avgFriendMsgChars: 1,
      avgFriendBurst: 1,
      turnCount: 1,
      pairCount: 0,
      corpusChars: 1,
      groupStyleMessageCount: 0,
    },
    corpusMessageCount: 1,
    pairCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}
