import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../common/atomic_write';

export interface GroupRosterMember {
  uid: string;
  uin: string;
  nick: string;
  card: string;
  memberLevel: number;
}

/** 完整在线名单按账号、按群原子保存；空数组也是有效快照，不与缺少缓存混淆。 */
export class GroupMemberRosterCache {
  constructor(private readonly root: string) {}

  private path(code: string) {
    if (!/^\d+$/.test(code)) throw new Error('群号格式错误');
    return join(this.root, `${code}.json`);
  }

  async codes(): Promise<string[]> {
    try {
      return (await readdir(this.root))
        .filter((name) => /^\d+\.json$/.test(name))
        .map((name) => name.slice(0, -5));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async read(code: string): Promise<GroupRosterMember[] | undefined> {
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

function isRosterMember(value: unknown): value is GroupRosterMember {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'uid' in value &&
      typeof value.uid === 'string' &&
      value.uid &&
      'uin' in value &&
      typeof value.uin === 'string' &&
      /^\d+$/.test(value.uin) &&
      'nick' in value &&
      typeof value.nick === 'string' &&
      'card' in value &&
      typeof value.card === 'string' &&
      'memberLevel' in value &&
      typeof value.memberLevel === 'number' &&
      Number.isFinite(value.memberLevel),
  );
}
