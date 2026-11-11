import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/atomic_write';
import type { ContactHistoryService } from './contact_history';
import { validGroupRosterMember as isRosterMember } from './contact_cache_validation';

export interface GroupRosterMember {
  uid: string;
  uin: string;
  nick: string;
  card: string;
  memberLevel: number;
}

/** 完整在线名单按账号、按群原子保存；空数组也是有效快照，不与缺少缓存混淆。 */
export class GroupMemberRosterCache {
  history?: ContactHistoryService;
  constructor(private readonly root: string) {}

  private path(code: string) {
    if (!/^\d+$/.test(code)) throw new Error('群号格式错误');
    return join(this.root, `${code}.json`);
  }

  async codes(): Promise<string[]> {
    const saved = this.history ? await this.history.memberGroups().catch(() => []) : [];
    try {
      return [
        ...new Set([
          ...saved,
          ...(await readdir(this.root))
            .filter((name) => /^\d+\.json$/.test(name))
            .map((name) => name.slice(0, -5)),
        ]),
      ];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return saved;
      throw error;
    }
  }

  async read(code: string): Promise<GroupRosterMember[] | undefined> {
    if (this.history) {
      const saved = (
        await Promise.all(
          (['local', 'online', 'legacy'] as const).map((source) =>
            this.history!.latest({
              entity: `group:${code}`,
              category: 'members',
              source,
              completeness: 'complete',
            }).catch(() => null),
          ),
        )
      )
        .filter((row) => row !== null)
        .sort((a, b) => b.last_at - a.last_at)[0];
      if (saved && Array.isArray(saved.value))
        return saved.value.map((value: Record<string, unknown>) => ({
          uid: String(value.uid ?? ''),
          uin: String(value.uin ?? ''),
          nick: String(value.nick ?? value.nickname ?? ''),
          card: String(value.card ?? ''),
          memberLevel: Number(value.memberLevel ?? value.level ?? 0),
        }));
    }
    try {
      const data: unknown = JSON.parse(await readFile(this.path(code), 'utf8'));
      if (
        !data ||
        typeof data !== 'object' ||
        !('version' in data) ||
        data.version !== 1 ||
        !('members' in data) ||
        !Array.isArray(data.members) ||
        !data.members.every(isRosterMember)
      )
        throw new Error('群成员快照格式错误');
      return data.members;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[group-roster] 读取群成员快照失败', code, error);
      return undefined;
    }
  }

  async save(code: string, members: GroupRosterMember[]) {
    if (!members.every(isRosterMember)) throw new Error('群成员身份未完整返回，保留旧名单');
    if (this.history) {
      await this.history.observe({
        entity: `group:${code}`,
        category: 'members',
        source: 'local',
        completeness: 'complete',
        value: members,
      });
      return;
    }
    await writeFileAtomic(
      this.path(code),
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        members,
      }),
    );
  }
}
