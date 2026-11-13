const proxy = (path = ''): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => ({
          data: path.endsWith('getGroupAlbumAccessState')
            ? { ocrLocalModelId: 'fixture' }
            : path.endsWith('getPackDetail')
              ? {
                  name: '合成表情包',
                  feeType: 'free',
                  count: 1,
                  items: [{ hash: 'fixture', name: '合成表情' }],
                }
              : path.endsWith('getPackKey')
                ? { key: 'fixture-key' }
                : undefined,
          isLoading: false,
          isFetching: false,
        });
      if (key === 'useMutation')
        return () => ({
          mutate() {},
          mutateAsync: async () => ({
            blocks: [
              {
                parag: 0,
                text: '用于验证窄屏工具条的合成识别结果。',
                rect: { x: 20, y: 20, width: 400, height: 40 },
              },
            ],
            imageWidth: 640,
            imageHeight: 480,
            source: 'local',
          }),
          isLoading: false,
        });
      if (key === 'query' || key === 'fetch' || key === 'invalidate') return async () => undefined;
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      return proxy(`${path}.${String(key)}`);
    },
  });
export const trpc = proxy();
export const client = proxy();
