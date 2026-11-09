/** 成员增减会改变偏移；旧分页失效后从首屏重读，连续变化则交给下一轮刷新。 */
export async function readFreshGroupMemberPage<T>(
  offset: number,
  version: () => number,
  load: (offset: number) => Promise<T[]>,
): Promise<{ page: T[]; offset: number; version: number } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = version();
    const page = await load(offset);
    if (started === version()) return { page, offset, version: started };
    offset = 0;
  }
  return null;
}

/** 退群成员仍用于历史发言人的名片解析，不再放回当前群成员列表。 */
export function activeGroupMembers<T extends { memberFlag?: number }>(members: readonly T[]): T[] {
  return members.filter((member) => member.memberFlag !== 1);
}
