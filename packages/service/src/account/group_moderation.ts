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
 * 生产环境注入共用逐操作权限检查；QQ 服务端仍决定最终受理结果及撤回时间窗口。
 */
import type { NtHelperBinding } from '@weq/native';
import type { QQGroupOperation } from '../common/qq_permissions';
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
  MuteGroupAll,
  type MuteGroupAllParams,
  RecallGroup,
  RecallPrivate,
  FetchGroupDetail,
  FetchGroupExtInfo,
  ModifyGroupExtInfo,
  GetAdminReceiveVerify,
  SetAdminReceiveVerify,
  SetGroupSearch,
  SetGroupInvitePolicy,
  SetGroupHistoryVisibility,
  SetGroupMemberPermission,
  decodeGroupHistoryVisibility,
  decodeGroupMemberPermissions,
  decodeMemberInvitePolicy,
  type GroupMemberInvitePolicy,
  SetAdminPermissions,
  type GroupAdminPermissionPatch,
  SetGroupAddOption,
  SetGroupAdmin,
  SetGroupMemberCard,
  SetGroupName,
  SetGroupSpecialTitle,
  SetGroupEssence,
  setGroupAvatar,
  type SetGroupNameParams,
  type SetGroupSpecialTitleParams,
  type SetGroupEssenceParams,
  type SetGroupAvatarParams,
  type AtAllRemain,
  type GroupCategoryTag,
  type GroupTodoAction,
  type GroupTodoListItem,
} from '@weqbot/protocol';

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
  /** 私聊的 clientSeq（本地库 40005）。 */
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

type GroupSettingSwitch =
  | 'newMemberHistory'
  | 'allowMemberUploadAlbum'
  | 'allowMemberTemporarySession'
  | 'allowMemberCreateGroup'
  | 'robotMemberSwitch'
  | 'robotMemberExamine';

const GROUP_SEARCH_FLAGS = {
  keyword_or_number: { noFingerOpen: 0, noCodeFingerOpen: 0 },
  number_only: { noFingerOpen: 1, noCodeFingerOpen: 0 },
  disabled: { noFingerOpen: 1, noCodeFingerOpen: 1 },
} as const;
type GroupSearchMode = keyof typeof GROUP_SEARCH_FLAGS;

type GroupSettingChange =
  | { key: GroupSettingSwitch; value: boolean }
  | { key: 'searchMode'; value: GroupSearchMode }
  | { key: 'invitePolicy'; value: GroupMemberInvitePolicy };

function decodeSwitch(value: number | undefined) {
  return value === 0 || value === 1 ? value === 1 : null;
}

export class GroupModerationService {
  constructor(
    private readonly nt: Pick<NtHelperBinding, 'sendOidbPacket' | 'sendPacket'>,
    private readonly resolvePid: () => number,
    private readonly authorize?: (
      action: QQGroupOperation,
      groupId: string | number,
      targetUid?: string,
      sequence?: number,
    ) => Promise<void>,
  ) {}

  private async permitted(
    action: QQGroupOperation,
    groupId: string | number,
    targetUid?: string,
    sequence?: number,
  ) {
    const pid = this.resolvePid();
    await this.authorize?.(action, groupId, targetUid, sequence);
    if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请重新操作');
    return pid;
  }

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
      await this.permitted('recall', groupId, undefined, params.sequence);
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
    await this.permitted('card', params.groupId, params.targetUid);
    await SetGroupMemberCard.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      targetUid: requireTargetUid(params.targetUid),
      card: params.card,
    });
  }

  async setName(params: SetGroupNameParams): Promise<void> {
    await this.permitted('name', params.groupId);
    await SetGroupName.invoke(this.nt, this.resolvePid(), params);
  }

  async setSpecialTitle(params: SetGroupSpecialTitleParams): Promise<void> {
    await this.permitted('title', params.groupId, params.targetUid);
    await SetGroupSpecialTitle.invoke(this.nt, this.resolvePid(), params);
  }

  async setEssence(params: SetGroupEssenceParams): Promise<void> {
    await this.permitted(
      params.enable ? 'essenceSet' : 'essenceRemove',
      params.groupId,
      undefined,
      params.sequence,
    );
    await SetGroupEssence.invoke(this.nt, this.resolvePid(), params);
  }

  async setAvatar(params: SetGroupAvatarParams): Promise<void> {
    await setGroupAvatar(this.nt, this.resolvePid(), params);
  }

  /** 踢出单个群成员（OIDB 0x8A0_1，群主 / 管理员）。 */
  async kickMember(params: KickMemberServiceParams): Promise<void> {
    await this.permitted(params.reject ? 'kickReject' : 'kick', params.groupId, params.targetUid);
    await KickGroupMember.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      targetUid: requireTargetUid(params.targetUid),
      reject: params.reject ?? false,
      ...(params.reason ? { reason: params.reason } : {}),
    });
  }

  /** 禁言单个群成员（OIDB 0x1253_1，群主 / 管理员）。`duration` 秒，0 = 解除。 */
  async muteMember(params: MuteMemberServiceParams): Promise<void> {
    await this.permitted('mute', params.groupId, params.targetUid);
    await MuteGroupMember.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      targetUid: requireTargetUid(params.targetUid),
      duration: params.duration,
    });
  }

  async muteAll(params: MuteGroupAllParams): Promise<void> {
    await this.permitted('manage', params.groupId);
    await MuteGroupAll.invoke(this.nt, this.resolvePid(), params);
  }

  /** 设置 / 取消群管理员（OIDB 0x1096_1，仅群主）。 */
  async setAdmin(params: SetAdminServiceParams): Promise<void> {
    await this.permitted('admin', params.groupId, params.targetUid);
    await SetGroupAdmin.invoke(this.nt, this.resolvePid(), {
      groupId: Number(params.groupId),
      targetUid: requireTargetUid(params.targetUid),
      enable: params.enable,
    });
  }

  async setAdminPermissions(
    groupId: number,
    userId: number,
    targetUid: string,
    patch: GroupAdminPermissionPatch,
  ) {
    const pid = await this.permitted('admin', groupId, requireTargetUid(targetUid));
    try {
      await SetAdminPermissions.invoke(this.nt, pid, { groupId, userId, ...patch });
    } catch (error) {
      if (error instanceof Error && /(?:OIDB error|status error:)\s*319\b/.test(error.message))
        throw new Error('QQ 拒绝当前客户端修改逐项管理员权限');
      throw error;
    }
  }

  async adminReceiveVerify(groupId: number, userId: number, targetUid: string) {
    const pid = this.resolvePid();
    const enabled = await GetAdminReceiveVerify.invoke(this.nt, pid, {
      groupId,
      userId,
      targetUid,
    });
    if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请刷新');
    return enabled;
  }

  async setAdminReceiveVerify(groupId: number, userId: number, targetUid: string, enable: boolean) {
    const pid = await this.permitted('admin', groupId, targetUid);
    await SetAdminReceiveVerify.invoke(this.nt, pid, { groupId, userId, enable });
  }

  async joinValidation(groupId: number) {
    const { option, question } = await this.joinSettings(groupId, false);
    return { option, question };
  }

  async joinSettings(groupId: number, includeAnswer = true) {
    const pid = this.resolvePid();
    const detail = await FetchGroupDetail.invoke(this.nt, pid, { groupId, includeAnswer });
    if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请刷新');
    return {
      option: detail.addType || null,
      question: detail.question || null,
      answer: includeAnswer ? detail.answer || null : null,
    };
  }

  async advancedSettings(groupId: number) {
    const pid = this.resolvePid();
    const [detail, robot] = await Promise.all([
      FetchGroupDetail.invoke(this.nt, pid, { groupId }),
      FetchGroupExtInfo.invoke(this.nt, pid, { groupId }).catch(() => null),
    ]);
    if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请刷新');
    const fields = detail.settingFields ?? {};
    const flags = fields.privilegeFlag;
    const member = flags === undefined ? null : decodeGroupMemberPermissions(flags);
    const searchMode = (Object.keys(GROUP_SEARCH_FLAGS) as GroupSearchMode[]).find((mode) => {
      const expected = GROUP_SEARCH_FLAGS[mode];
      return (
        fields.noFingerOpen === expected.noFingerOpen &&
        fields.noCodeFingerOpen === expected.noCodeFingerOpen
      );
    });
    return {
      privilegeFlag: flags ?? null,
      searchMode: searchMode ?? null,
      invitePolicy: flags === undefined ? null : decodeMemberInvitePolicy(flags),
      newMemberHistory:
        fields.groupFlagExt4 === undefined
          ? null
          : decodeGroupHistoryVisibility(fields.groupFlagExt4),
      allowMemberUploadAlbum: member?.allowMemberUploadAlbum ?? null,
      allowMemberTemporarySession: member?.allowMemberTemporarySession ?? null,
      allowMemberCreateGroup: member?.allowMemberCreateGroup ?? null,
      robotMemberSwitch: decodeSwitch(robot?.settingFields?.robotMemberSwitch),
      robotMemberExamine: decodeSwitch(robot?.settingFields?.robotMemberExamine),
    };
  }

  async setAdvancedSetting(groupId: number, change: GroupSettingChange, beforeSend: () => void) {
    const pid = await this.permitted('manage', groupId);
    const checkCurrent = () => {
      beforeSend();
      if (this.resolvePid() !== pid) throw new Error('QQ 运行时已改变，请重新操作');
    };
    if (change.key === 'searchMode') {
      // 三档各自给出完整字段，指定档位无需依赖旧值。
      checkCurrent();
      return SetGroupSearch.invoke(this.nt, pid, {
        groupId,
        ...GROUP_SEARCH_FLAGS[change.value],
      });
    }
    const settings = await this.advancedSettings(groupId);
    checkCurrent();
    if (settings[change.key] === null) throw new Error('服务端未返回对应设置，请刷新后重试');
    if (settings[change.key] === change.value) return;
    switch (change.key) {
      case 'newMemberHistory':
        return SetGroupHistoryVisibility.invoke(this.nt, pid, { groupId, visible: change.value });
      case 'invitePolicy':
        if (settings.privilegeFlag === null) throw new Error('群邀请设置不可读');
        return SetGroupInvitePolicy.invoke(this.nt, pid, {
          groupId,
          currentPrivilegeFlag: settings.privilegeFlag,
          policy: change.value,
        });
      case 'robotMemberSwitch':
      case 'robotMemberExamine':
        return ModifyGroupExtInfo.invoke(this.nt, pid, {
          groupId,
          [change.key]: Number(change.value),
        });
      default: {
        const permission = {
          allowMemberUploadAlbum: 'upload_album',
          allowMemberTemporarySession: 'temporary_session',
          allowMemberCreateGroup: 'create_group',
        } as const;
        if (settings.privilegeFlag === null) throw new Error('群成员权限不可读');
        return SetGroupMemberPermission.invoke(this.nt, pid, {
          groupId,
          currentPrivilegeFlag: settings.privilegeFlag,
          permission: permission[change.key],
          allow: change.value,
        });
      }
    }
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
