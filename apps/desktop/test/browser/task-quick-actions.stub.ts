declare global {
  interface Window {
    taskQuickCalls: Array<{ action: string; input: unknown }>;
  }
}
window.taskQuickCalls = [];
const flash = (id: string, count: number) => {
  const file = {
    id,
    name: `合成下载-${id}`,
    filesetName: '集合',
    relativePath: 'file.txt',
    targetPath: '/synthetic/file.txt',
    status: 'done',
    fileSize: 10,
    downloadedBytes: 10,
  };
  return {
    ...file,
    files: Array.from({ length: count }, (_, index) => ({ ...file, id: `${id}-${index}` })),
  };
};
const proxy = (path: string[] = []): unknown =>
  new Proxy(() => proxy(path), {
    get: (_target, key: string) => {
      if (key === 'useQuery')
        return () => ({
          data:
            path.at(-1) === 'flashListDownloadTasks'
              ? [flash('single', 1), flash('batch', 2)]
              : undefined,
          isLoading: false,
          isFetching: false,
          refetch: async () => ({ data: undefined }),
        });
      if (key === 'useMutation')
        return () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false });
      if (key === 'mutate')
        return async (input: unknown) => {
          window.taskQuickCalls.push({ action: path.join('.'), input });
          return true;
        };
      if (['query', 'fetch', 'invalidate'].includes(key)) return async () => undefined;
      if (key === 'subscribe') return () => ({ unsubscribe() {} });
      return proxy([...path, key]);
    },
  });
export const trpc = proxy();
export const client = proxy();
