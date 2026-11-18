import {
  DEFAULT_INTENT_TUNING,
  DEFAULT_SUGGESTION_FALLBACK_TEXTS,
} from '@weq/service/intent-context';
import { useSyncExternalStore } from 'react';
import {
  DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
} from '@weq/agentlab/model-metadata';

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const tokenDefaults = {
  defaultContextWindowTokens: DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS,
  defaultMaxOutputTokens: DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
};
const data: Record<string, unknown> = {
  'bootstrap.getSettings': { agentLab: tokenDefaults },
  'settings.intent.getStatus': {
    ...DEFAULT_INTENT_TUNING,
    suggestionFallbackTexts: [...DEFAULT_SUGGESTION_FALLBACK_TEXTS],
    enabled: false,
    profileEnabled: false,
    suggestionsEnabled: false,
    engine: new URLSearchParams(location.search).has('local-model') ? 'local' : 'api',
    profileEngine: 'api',
    providerRef: null,
    profileProviderRef: null,
    suggestionProviderRef: null,
  },
  'bootstrap.getAgentLabDefaultModel': {
    ref: { providerId: 'fixture', model: 'gpt-fixture-long-model-name' },
    available: true,
  },
  'bootstrap.listAgentLabProviders': [
    {
      id: 'fixture',
      name: '合成服务商',
      vendor: 'custom',
      baseUrl: 'https://api.example.invalid/v1',
      apiKey: 'synthetic-key',
      models: [{ id: 'gpt-fixture-long-model-name', capabilities: ['chat'] }],
    },
  ],
  'bootstrap.getAgentLabCatalog': [
    { vendor: 'custom', label: 'OpenAI 兼容（自定义）', baseUrl: '', models: [] },
  ],
  'bootstrap.getDefaultVisionModel': { ref: null, available: false },
  'bootstrap.getDefaultEmbeddingModel': { ref: null, available: false },
  'bootstrap.localModelResources': { selected: { intent: 'auto' } },
  'bootstrap.getLocalEngine': { available: false, models: [] },
};
Object.assign(window, { aiSettingsStatus: () => data['settings.intent.getStatus'] });
const proxy = (path = ''): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'useUtils') return () => proxy('utils');
      if (key === 'setData')
        return (_input: unknown, next: unknown) => {
          const query = path.replace(/^utils\./, '');
          data[query] = typeof next === 'function' ? next(data[query]) : next;
          for (const listener of listeners) listener();
        };
      if (key === 'useQuery')
        return () => ({
          data: useSyncExternalStore(subscribe, () => data[path]),
          isLoading: false,
          refetch: async () => ({ data: data[path] }),
        });
      if (key === 'useMutation')
        return () => ({
          isLoading: false,
          mutateAsync: async (input: { modelIds?: string[] }) =>
            path === 'settings.intent.setConfig'
              ? { ...(data['settings.intent.getStatus'] as object), ...input }
              : path === 'bootstrap.fetchAgentLabModels'
                ? (input.modelIds ?? []).map((id) => ({
                    id,
                    capabilities: ['chat'],
                    metadata: {
                      capabilities: {
                        chat: 'supported',
                        embedding: 'unsupported',
                        vision: 'unsupported',
                      },
                      reasoning: { supported: false, controls: [] },
                      raw: {},
                      source: 'fixture',
                      fetchedAt: 1,
                    },
                  }))
                : path === 'bootstrap.setAgentLabModelTokenDefaults'
                  ? { ...Object.assign(tokenDefaults, input) }
                  : undefined,
        });
      if (key === 'useSubscription') return () => {};
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
export const trpc = proxy();
export const client = proxy();
