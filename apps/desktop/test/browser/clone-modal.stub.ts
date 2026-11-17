const data: Record<string, unknown> = {
  getSettings: { aiImages: { cloneTraining: 'placeholder' } },
  listAgentLabProviders: [
    {
      id: 'synthetic',
      name: '合成服务',
      baseUrl: 'https://synthetic.invalid',
      models: [{ id: 'chat', capabilities: ['chat'] }],
    },
  ],
  getAgentLabDefaultModel: {
    ref: { providerId: 'synthetic', model: 'chat' },
    available: true,
  },
  getDefaultEmbeddingModel: { ref: null, available: false },
};
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => ({ data: data[path.at(-1)!], isLoading: false, isFetching: false });
      if (key === 'useMutation')
        return () => ({ mutateAsync: async () => undefined, isLoading: false });
      if (key === 'invalidate') return async () => undefined;
      return proxy([...path, String(key)]);
    },
  });
export const trpc = proxy();
export const client = proxy();
