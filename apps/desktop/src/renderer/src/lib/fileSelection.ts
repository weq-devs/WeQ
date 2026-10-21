/** 已选目录覆盖其后代，避免范围选择将同一个文件重复加入下载批次。 */
export function pruneNestedSelection<T extends { path: string; isDir: boolean }>(
  input: ReadonlyMap<string, T>,
): Map<string, T> {
  const directories = new Set(
    [...input.values()].filter((item) => item.isDir).map((item) => item.path),
  );
  return new Map(
    [...input].filter(([, item]) => {
      for (
        let index = item.path.indexOf('/');
        index >= 0;
        index = item.path.indexOf('/', index + 1)
      ) {
        if (directories.has(item.path.slice(0, index))) return false;
      }
      return true;
    }),
  );
}
