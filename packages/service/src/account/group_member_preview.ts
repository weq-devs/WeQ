import type { GroupMember } from '@weq/db';

export const GROUP_PREVIEW_LIMIT = 8;
export const GROUP_PREVIEW_CANDIDATES = 32;
export interface GroupMemberPreview {
  members: GroupMember[];
  source: 'local' | 'cache' | 'online';
  partial: boolean;
  error: string | null;
}
export function selectPreviewMembers(members: GroupMember[], friends: ReadonlySet<string>) {
  const unique = new Map<string, GroupMember>();
  for (const member of members) {
    if (member.memberFlag === 1 || !member.uid || member.uin <= 0n) continue;
    if (!unique.has(member.uid)) unique.set(member.uid, member);
  }
  return [...unique.values()]
    .sort(
      (a, b) =>
        Number(friends.has(b.uid) || friends.has(String(b.uin))) -
        Number(friends.has(a.uid) || friends.has(String(a.uin))),
    )
    .slice(0, GROUP_PREVIEW_LIMIT);
}

/** 局部预览独立缓存，绝不投影成完整名单或联系人计数。 */
export class GroupMemberPreviewReader {
  private cache = new Map<string, { at: number; value: GroupMemberPreview }>();
  private inflight = new Map<string, Promise<GroupMemberPreview>>();
  async read(
    code: string,
    readers: {
      local: () => Promise<GroupMember[]>;
      friends: () => Promise<ReadonlySet<string>>;
      cached: () => GroupMember[];
      online?: () => Promise<GroupMember[]>;
    },
  ): Promise<GroupMemberPreview> {
    const saved = this.cache.get(code);
    if (saved && Date.now() - saved.at < 60_000) return structuredClone(saved.value);
    const pending = this.inflight.get(code);
    if (pending) return structuredClone(await pending);
    const task = (async () => {
      const [local, friendResult] = await Promise.allSettled([readers.local(), readers.friends()]);
      const friends = friendResult.status === 'fulfilled' ? friendResult.value : new Set<string>();
      let candidates =
        local.status === 'fulfilled' ? local.value.slice(0, GROUP_PREVIEW_CANDIDATES) : [];
      let source: GroupMemberPreview['source'] = 'local';
      let error =
        local.status === 'rejected'
          ? '本地成员预览读取失败'
          : friendResult.status === 'rejected'
            ? '好友关系暂不可用'
            : null;
      if (selectPreviewMembers(candidates, friends).length < GROUP_PREVIEW_LIMIT) {
        let cached: GroupMember[] = [];
        try {
          cached = readers.cached().slice(0, GROUP_PREVIEW_CANDIDATES);
        } catch {
          error = '成员缓存暂不可用';
        }
        if (cached.length) {
          candidates = [...candidates, ...cached];
          source = 'cache';
        }
      }
      if (
        selectPreviewMembers(candidates, friends).length < GROUP_PREVIEW_LIMIT &&
        readers.online
      ) {
        try {
          candidates = [...candidates, ...(await readers.online())];
          source = 'online';
        } catch {
          error = '在线成员预览读取失败，保留已有成员';
        }
      }
      const value = {
        members: selectPreviewMembers(candidates, friends),
        source,
        partial: true,
        error,
      };
      if (!error) this.cache.set(code, { at: Date.now(), value });
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
      return value;
    })().finally(() => this.inflight.delete(code));
    this.inflight.set(code, task);
    return structuredClone(await task);
  }
}
