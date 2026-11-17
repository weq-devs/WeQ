/** 系统表情匹配上下文：whitelist=本克隆体用过的 faceText；descToId=外显文字→faceId。 */
export interface FaceContext {
  whitelist: string[];
  descToId: Map<string, number>;
}

/** 输入工具栏插入的 /表情名使用完整系统表情表，不受克隆体训练白名单限制。 */
export function inputFaceContext(descToId: Map<string, number>): FaceContext {
  return { whitelist: [...descToId.keys()].map((name) => `/${name}`), descToId };
}

/** 归一化 faceText / 表情外显文字：去掉 /、[]、【】、空白后比对（"/捂脸"="[捂脸]"="捂脸"）。 */
export function normFaceKey(s: string): string {
  return s.replace(/[/[\]【】\s]/g, '').toLowerCase();
}

/** 由 getSystemFaces 结果构建 归一化外显文字 → faceId 的映射。 */
export function buildFaceMap(
  entries: ReadonlyArray<{ id: number; desc: string }>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const e of entries) {
    const key = normFaceKey(e.desc);
    if (key && !map.has(key)) map.set(key, e.id);
  }
  return map;
}
