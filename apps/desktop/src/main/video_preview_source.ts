type Entry = { url: Promise<string | null>; expires: number };
const sources = new WeakMap<object, Map<string, Entry>>();
const SOURCE_TTL_MS = 15_000;

/** 进度条连续拖动时复用当前账号刚解析的片源；显式保存走现签入口。 */
export function videoPreviewSource(
  owner: object,
  key: string,
  resolve: () => Promise<string | null>,
) {
  let entries = sources.get(owner);
  if (!entries) {
    entries = new Map();
    sources.set(owner, entries);
  }
  const cache = entries;
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) {
    return {
      reused: true,
      url: existing.url,
      invalidate: () => {
        if (cache.get(key) === existing) cache.delete(key);
      },
    };
  }
  cache.delete(key);
  const entry: Entry = { url: resolve(), expires: Date.now() + SOURCE_TTL_MS };
  const invalidate = () => {
    if (cache.get(key) === entry) cache.delete(key);
  };
  cache.set(key, entry);
  while (cache.size > 48) cache.delete(cache.keys().next().value!);
  void entry.url.then((url) => {
    if (!url) invalidate();
  }, invalidate);
  return { reused: false, url: entry.url, invalidate };
}
