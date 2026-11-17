export type GroupMemberLookup<T> = (input: { groupCode: string; uids: string[] }) => Promise<T[]>;

/** 同一账号的聊天与列表只共享在途读取；完成即释放，失效后不复用旧查询。 */
export function createGroupMemberLookup<T extends { uid: string }>(read: GroupMemberLookup<T>) {
  const pending = new Map<string, Map<string, Promise<T | undefined>>>();
  const load: GroupMemberLookup<T> = async ({ groupCode, uids }) => {
    if (!uids.length) return [];
    let group = pending.get(groupCode);
    if (!group) {
      group = new Map();
      pending.set(groupCode, group);
    }
    const current = group;
    const unique = [...new Set(uids)];
    const missing = unique.filter((uid) => !current.has(uid));
    if (missing.length) {
      const batch = Promise.resolve()
        .then(() => read({ groupCode, uids: missing }))
        .then((rows) => new Map(rows.map((row) => [row.uid, row])));
      for (const uid of missing) {
        const result = batch.then((rows) => rows.get(uid));
        current.set(uid, result);
        const release = () => {
          if (current.get(uid) === result) current.delete(uid);
          if (!current.size && pending.get(groupCode) === current) pending.delete(groupCode);
        };
        void result.then(release, release);
      }
    }
    const rows = await Promise.all(unique.map((uid) => current.get(uid)!));
    return rows.filter((row) => row !== undefined);
  };
  return { load, invalidate: () => pending.clear() };
}

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
