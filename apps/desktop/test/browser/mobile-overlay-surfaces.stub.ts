const gift = {
  giftId: 1,
  giftName: '合成礼物',
  giftPrice: 1,
  giftDesc: '合成礼物详情，用于检查祝福语及底部操作。',
};
const data: Record<string, unknown> = {
  'account.listGroupAlbums': [],
  'account.listGroupAlbumBrowse': { albums: [], complete: true },
  'account.listGroupFiles': { files: [], folders: [] },
  'account.getGroupAlbumAccessState': { qqOnline: false, attachEnabled: false },
  'account.giftMall.list': { giftList: [gift], attachInfo: '', isEnd: true },
  'account.giftMall.search': { giftList: [gift], attachInfo: '', isEnd: true },
  'account.giftMall.detail': { giftInfo: gift },
  'account.dressup.getState': { qqOnline: true },
  'account.dressup.rank': {
    items: Array.from({ length: 8 }, (_, index) => ({
      itemId: index + 10,
      name: `合成款 ${index}`,
    })),
  },
  'bootstrap.getSettings': { voiceTranscribe: { modelId: '' } },
};
const results = new Map<string, object>();
function proxy(path = ''): unknown {
  return new Proxy(() => proxy(path), {
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => {
          if (!results.has(path))
            results.set(path, { data: data[path], isLoading: false, isFetching: false });
          return results.get(path);
        };
      if (key === 'query' || key === 'mutate') return async () => data[path];
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const client = proxy();
export const trpc = proxy();
