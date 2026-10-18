/**
 * GroupModerationService — 会话治理类协议：撤回消息 + 群管理（改群名片 / 踢人 /
 * 禁言 / 设撤管理员）。
 *
 * 与 {@link InteractionService} 同构：只负责在在线 pid 上发包，离线 / 风控失败
 * 原样上抛。由渲染层通过 account tRPC router 驱动。
 *
 * ⚠️ 这些方法**不做任何本地写库 / 乐观更新** —— 撤回尤其不能乐观：本机开着防撤回
 * 触发器时，本地库里「消息还在」与「服务端已撤回」是两回事，撤回标记只能等 QQ
 * 同步回来（SQL 触发器）才自证。调用方点完只看 toast。
 *
 * 权限（2 分钟窗口 / 群主管理员越级）由**服务端**判定；这里不预判，只如实上抛。
 */
import type { NtHelperBinding } from '@weq/native';
import {
  AddGroupCategoryTag,
  DeleteGroupCategoryTag,
  GetGroupAtAllRemain,
  GetGroupCategoryTags,
  GetGroupTodoList,
  GroupTodo,
  KickGroupMember,
  LeaveGroup,
  MuteGroupMember,
  RecallGroup,
  RecallPrivate,
  SetGroupAddOption,
  SetGroupAdmin,
  SetGroupMemberCard,
  type AtAllRemain,
  type GroupCategoryTag,
  type GroupTodoAction,
  type GroupTodoListItem,
} from '@weq/protocol';

/** 撤回一条消息的定位参数。 */
export interface RecallMessageParams {
  /** c2c = 私聊，group = 群聊。 */
  kind: 'c2c' | 'group';
  /** 会话标识：群聊为群号，私聊为对方 uid。 */
  conv: string;
  /** 被撤回消息的会话内序号（msgSeq）。 */
  sequence: number;
  /** 该消息的 wire 层 random（本地库 40002）；拿不到给 0。 */
  random?: number;
  /** 该消息发送时间（unix 秒）；私聊撤回要用。 */
  timestamp?: number;
  /** 私聊的 clientSeq；本地库里没有这一列，缺省 0。 */
  clientSequence?: number;
}

export interface SetMemberCardServiceParams {
  groupId: string | number;
  /** 目标成员的 NT uid（**不是** uin）。 */
  targetUid: string;
  /** 新群名片；空串 = 清除。 */
  card: string;
}

export interface KickMemberServiceParams {
  groupId: string | number;
  targetUid: string;
  /** 是否拒绝该成员后续的加群申请。缺省 false。 */
  reject?: boolean;
  reason?: string;
}

export interface MuteMemberServiceParams {
  groupId: string | number;
  targetUid: string;
  /** 禁言时长（秒）。0 = 立即解除禁言。 */
  duration: number;
}

export interface SetAdminServiceParams {
  groupId: string | number;
  targetUid: string;
  /** true = 设为管理员，false = 取消。 */
  enable: boolean;
}

/** 目标 uid 一律由调用方给定（渲染层从成员表 / 发送者拿到），这里只做非空校验。 */
function requireTargetUid(uid: string): string {
  const text = String(uid ?? '').trim();
  if (!text) throw new Error('目标成员 uid 不能为空。');
  return text;
}

export class GroupModerationService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket' | 'sendPacket'>,
    private readonly resolvePid: () => number,
  ) {}

  /**
   * 撤回一条消息。
   *
   * 群聊 `SsoGroupRecallMsg`（needSign=false，按 sequence + random 定位）；
   * 私聊 `SsoC2CRecallMsg`（needSign=true，按 targetUid + random + msgSeq +
   * timestamp 定位）。撤回自己与别人的消息都是这条命令，是否放行由服务端按
   * 2 分钟窗口 / 管理员权限判定。
   */
  async recallMessage(params: RecallMessageParams): Promise<void> {
    const pid = this.resolvePid();
    if (params.kind === 'group') {
      const groupId = Number(params.conv);
      await RecallGroup.invoke(this.nt, pid, {
        groupId,
        sequence: params.sequence,
        ...(params.random && params.random > 0 ? { random: params.random } : {}),
      });
      return;
    }
    const targetUid = requireTargetUid(params.conv);
    await RecallPrivate.invoke(this.nt, pid, {
      targetUid,
      clientSequence: params.clientSequence ?? 0,
      messageSequence: params.sequence,
      random: params.random ?? 0,
      timestamp: params.timestamp ?? 0,
    });
  }

  /** 设置群成员群名片（OIDB 0x8FC_3）。给自己改 = 改自己的群昵称。 */
  async setMemberCard(params: SetMemberCardServiceParams): Promise<void> {
    await SetGroupMemberCard.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      targetUid: requireTargetUid(params.targetUid),
      card: params.card,
    });
  }

  /** 踢出单个群成员（OIDB 0x8A0_1，群主 / 管理员）。 */
  async kickMember(params: KickMemberServiceParams): Promise<void> {
    await KickGroupMember.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      targetUid: requireTargetUid(params.targetUid),
      reject: params.reject ?? false,
      ...(params.reason ? { reason: params.reason } : {}),
    });
  }

  /** 禁言单个群成员（OIDB 0x1253_1，群主 / 管理员）。`duration` 秒，0 = 解除。 */
  async muteMember(params: MuteMemberServiceParams): Promise<void> {
    await MuteGroupMember.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      targetUid: requireTargetUid(params.targetUid),
      duration: params.duration,
    });
  }

  /** 设置 / 取消群管理员（OIDB 0x1096_1，仅群主）。 */
  async setAdmin(params: SetAdminServiceParams): Promise<void> {
    await SetGroupAdmin.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      targetUid: requireTargetUid(params.targetUid),
      enable: params.enable,
    });
  }

  /** 退群（OIDB 0x1097_1）。 */
  async leaveGroup(groupId: string | number): Promise<void> {
    await LeaveGroup.invoke(this.nt, this.resolvePid(), { groupId: Number(groupId) });
  }

  /** 设置加群方式（OIDB 0x89A_0）。`addType` 见 {@link SetGroupAddOptionParams}。 */
  async setAddOption(params: {
    groupId: string | number;
    addType: number;
    groupQuestion?: string;
    groupAnswer?: string;
  }): Promise<void> {
    await SetGroupAddOption.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      addType: params.addType,
      ...(params.groupQuestion !== undefined ? { groupQuestion: params.groupQuestion } : {}),
      ...(params.groupAnswer !== undefined ? { groupAnswer: params.groupAnswer } : {}),
    });
  }

  /** 查询当前账号在该群还剩多少次 @全体成员（OIDB 0x8A7_0）。 */
  async getAtAllRemain(groupId: string | number, selfUin: string | number): Promise<AtAllRemain> {
    return GetGroupAtAllRemain.invoke(this.nt, this.resolvePid(), {
      groupId: Number(groupId),
      selfUin,
    });
  }

  /** 群分类下的资料标签（OIDB 0x967C_0）。 */
  async getCategoryTags(groupClass: number): Promise<GroupCategoryTag[]> {
    return GetGroupCategoryTags.invoke(this.nt, this.resolvePid(), { groupClass });
  }

  /** 添加资料标签（OIDB 0x967D_0）。 */
  async addCategoryTag(groupClass: number, name: string): Promise<void> {
    await AddGroupCategoryTag.invoke(this.nt, this.resolvePid(), { groupClass, name });
  }

  /** 删除资料标签（OIDB 0x967E_0）。 */
  async deleteCategoryTag(groupClass: number, name: string): Promise<void> {
    await DeleteGroupCategoryTag.invoke(this.nt, this.resolvePid(), { groupClass, name });
  }

  /** 设置 / 完成 / 取消群待办（OIDB 0xF90）。 */
  async setTodo(
    groupId: string | number,
    msgSeq: number | bigint,
    action: GroupTodoAction,
  ): Promise<void> {
    await GroupTodo.invoke(this.nt, this.resolvePid(), {
      groupId: Number(groupId),
      msgSeq,
      action,
    });
  }

  /** 当前群的群待办列表（OIDB 0x9474_0）。 */
  async getTodoList(groupId: string | number): Promise<GroupTodoListItem[]> {
    return GetGroupTodoList.invoke(this.nt, this.resolvePid(), { groupId: Number(groupId) });
  }
}
