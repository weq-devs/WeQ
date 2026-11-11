import type { GroupMember } from '@weq/db';
import {
  getGroupMemberNotify,
  setGroupMemberNotify,
  LegacyOidbRejectedError,
  type GroupMemberNotifyMode,
  type TrpcNative,
} from '@weq/protocol';

/** 当前会话内的小范围个人设置，不依赖好友关系或群管理角色。 */
export class GroupMemberNotifyService {
  private readonly pending = new Set<string>();
  constructor(
    private readonly nt: TrpcNative,
    private readonly resolvePid: () => number,
    private readonly getMember: (
      groupCode: bigint,
      uid: string,
    ) => Promise<Pick<GroupMember, 'groupCode' | 'uid' | 'uin'> | null>,
  ) {}
  private check(pid: number) {
    if (this.resolvePid() !== pid) throw new Error('账号连接已切换，请重新读取群内消息提醒');
  }
  private async target(groupId: number, uid: string, pid: number) {
    if (
      !Number.isSafeInteger(groupId) ||
      groupId <= 0 ||
      groupId > 0xffffffff ||
      !/^u_[A-Za-z0-9_-]+$/.test(uid)
    )
      throw new Error('群成员提醒目标无效');
    const member = await this.getMember(BigInt(groupId), uid);
    this.check(pid);
    if (!member || member.uin <= 0n) throw new Error('尚未取得该群成员的 QQ 号，请刷新成员资料');
    if (member.groupCode !== BigInt(groupId) || member.uid !== uid)
      throw new Error('群成员提醒目标不一致');
    return { groupId, memberUin: String(member.uin) };
  }
  async read(groupId: number, uid: string) {
    const pid = this.resolvePid();
    const target = await this.target(groupId, uid, pid);
    const state = await getGroupMemberNotify(this.nt, pid, target);
    this.check(pid);
    return { ...state, uid };
  }
  async set(groupId: number, uid: string, mode: GroupMemberNotifyMode) {
    if (!['default', 'concerned', 'shielded'].includes(mode))
      throw new Error('群内消息提醒状态无效');
    const key = `${groupId}:${uid}`;
    if (this.pending.has(key)) throw new Error('该成员的消息提醒正在保存');
    this.pending.add(key);
    try {
      const pid = this.resolvePid();
      const original = await this.read(groupId, uid);
      this.check(pid);
      if (!original.complete) throw new Error('群内消息提醒状态尚未取得，请重新读取');
      if (original.mode === mode) return { state: 'unchanged' as const };
      try {
        await setGroupMemberNotify(this.nt, pid, { ...original, mode });
      } catch (error) {
        this.check(pid);
        if (error instanceof LegacyOidbRejectedError) throw error;
        // 请求可能已经提交；后续只独立读回，不重放写请求。
        return { state: 'unconfirmed' as const };
      }
      this.check(pid);
      return { state: 'accepted' as const };
    } finally {
      this.pending.delete(key);
    }
  }
}
