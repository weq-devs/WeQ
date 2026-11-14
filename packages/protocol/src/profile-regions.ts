export interface QqRegion {
  code: string;
  name: string;
  children: QqRegion[];
}
/** 浏览器与 Node 共用地区格式，不引入协议传输或 Node 内置模块。 */
export function formatQqRegion(
  path: readonly string[] | null | undefined,
  regions: readonly QqRegion[] | undefined,
): string | null {
  if (!path || !regions) return null;
  let nodes = regions;
  return (
    path
      .map((code) => {
        const node = nodes.find((row) => row.code === code);
        nodes = node?.children ?? [];
        return node?.name ?? (code === '0' ? '' : code);
      })
      .filter(Boolean)
      .join(' · ') || '未设置'
  );
}
