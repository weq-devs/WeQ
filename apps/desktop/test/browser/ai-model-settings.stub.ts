import {
  DEFAULT_INTENT_TUNING,
  DEFAULT_SUGGESTION_FALLBACK_TEXTS,
} from '@weq/service/intent-context';

const data: Record<string, unknown> = {
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
  'bootstrap.localModelResources': { selected: { intent: 'auto' } },
  'bootstrap.getLocalEngine': { available: false, models: [] },
};
const proxy = (path = ''): unknown =>
  new Proxy(() => undefined, {
    get(_target, key) {
      if (key === 'useUtils') return () => proxy('utils');
      if (key === 'useQuery')
        return () => ({
          data: data[path],
          isLoading: false,
          refetch: async () => ({ data: data[path] }),
        });
      if (key === 'useMutation')
        return () => ({ isLoading: false, mutateAsync: async () => undefined });
      if (key === 'useSubscription') return () => {};
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
export const trpc = proxy();
export const client = proxy();
