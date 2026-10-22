import type { Buddy, Category } from '@weq/db';
import {
  ClearFriendRemark,
  SetFriendRemark,
  SetGroupRemark,
  SetPeerPin,
  SetFriendDisturb,
  GetFriendSnsPage,
  SetFriendSpecialCare,
  type FriendSnsPage,
  getCloudProfile,
  getCommonFriendCount,
  getCommonGroups,
  GetGroupJoinInfo,
  readEditableProfile,
  writeEditableProfile,
  encodeEditableProfile,
  type EditableProfilePatch,
  SetGroupMessagePolicy,
  MoveFriendCategory,
  CreateFriendCategory,
  UpdateFriendCategories,
  DeleteFriendCategory,
  SetSelfProfile,
  SetOnlineStatus,
  setSelfAvatar,
  setGroupAvatar,
  type PacketNative,
  type PeerPreferenceTarget,
  type GroupMessagePolicy,
  type SelfProfilePatch,
  type SetOnlineStatusParams,
} from '@weq/protocol';

export interface AccountWriteIdentity {
  uin: string;
  selfUid: string;
  getBuddy: (uid: string) => Promise<Buddy | null>;
  listCategories: () => Promise<Category[]>;
  clientVersion?: () => string;
}

export interface AccountWriteOutcome {
  /** confirmed 仅表示服务端确认了目标和值，不代表 QQ 本地缓存已经刷新。 */
  state: 'confirmed' | 'accepted' | 'unconfirmed' | 'unchanged';
}

/** 编排账号操作及配套读回；不写 QQ 原库、不自动重发写请求。 */
export class AccountWriteService {
  constructor(
    private readonly nt: PacketNative,
    private readonly identity: AccountWriteIdentity,
    private readonly resolvePid: () => number,
  ) {}

  selfIdentity(): { uin: string; uid: string } {
    return { uin: this.identity.uin, uid: this.identity.selfUid };
  }

  async exactProfile(kind: 'user' | 'group', target: string) {
    const pid = this.resolvePid();
    if (kind === 'group') {
      const group = await GetGroupJoinInfo.invoke(this.nt, pid, { groupId: Number(target) });
      this.assertCurrentPid(pid);
      return {
        kind,
        id: String(group.groupId),
        name: group.name,
        level: null,
        category: group.categoryName,
      };
    }
    const profile = await getCloudProfile(this.nt, pid, target, [105, 20002]);
    this.assertCurrentPid(pid);
    const nick = profile.bytes.get(20002);
    return {
      kind,
      id: target,
      name: nick === undefined ? '' : new TextDecoder('utf-8', { fatal: true }).decode(nick),
      level: profile.numbers.get(105) ?? null,
      category: null,
    };
  }

  async commonRelationships(target: string) {
    const pid = this.resolvePid();
    const [friends, groups] = await Promise.allSettled([
      getCommonFriendCount(this.nt, pid, this.identity.uin, target),
      Promise.resolve().then(() =>
        getCommonGroups(
          this.nt,
          pid,
          this.identity.uin,
          target,
          this.identity.clientVersion?.() ?? '',
        ),
      ),
    ]);
    this.assertCurrentPid(pid);
    return {
      friendCount: friends.status === 'fulfilled' ? friends.value : null,
      groups: groups.status === 'fulfilled' ? groups.value : null,
      friendError: friends.status === 'rejected' ? '共同好友读取失败' : null,
      groupError: groups.status === 'rejected' ? '共同群读取失败' : null,
    };
  }

  async editableSelfProfile() {
    const pid = this.resolvePid();
    const result = await readEditableProfile(
      this.nt,
      pid,
      this.identity.uin,
      this.identity.selfUid,
    );
    this.assertCurrentPid(pid);
    return result;
  }

  async editSelfProfile(patch: EditableProfilePatch): Promise<AccountWriteOutcome> {
    encodeEditableProfile(patch);
    const pid = this.resolvePid();
    const original = await this.editableSelfProfile();
    for (const field of Object.keys(patch) as Array<keyof EditableProfilePatch>) {
      if (original.errors[field]) throw new Error(original.errors[field]);
    }
    this.assertCurrentPid(pid);
    try {
      await writeEditableProfile(this.nt, pid, this.identity.uin, patch);
    } catch {
      this.assertCurrentPid(pid);
      return { state: 'unconfirmed' };
    }
    this.assertCurrentPid(pid);
    return { state: 'unconfirmed' };
  }

  private async friend(uid: string): Promise<Buddy> {
    const buddy = await this.identity.getBuddy(uid);
    if (!buddy) throw new Error('目标不是当前账号的好友');
    return buddy;
  }

  async friendRemark(uid: string, remark: string): Promise<AccountWriteOutcome> {
    if (remark !== '') SetFriendRemark.serialize({ uid, remark });
    await this.friend(uid);
    const pid = this.resolvePid();
    await this.getFriendRemark(uid);
    this.assertCurrentPid(pid);
    try {
      if (remark === '') {
        await ClearFriendRemark.invoke(this.nt, pid, { uid });
        this.assertCurrentPid(pid);
        return { state: 'accepted' };
      }
      await SetFriendRemark.invoke(this.nt, pid, { uid, remark });
      this.assertCurrentPid(pid);
      return { state: 'confirmed' };
    } catch {
      this.assertCurrentPid(pid);
      return { state: 'unconfirmed' };
    }
  }

  async getFriendRemark(uid: string) {
    const row = await this.friendSns(uid, false, true);
    return { uid, remark: row.remark ?? null };
  }

  async groupRemark(groupId: number, remark: string): Promise<AccountWriteOutcome> {
    await SetGroupRemark.invoke(this.nt, this.resolvePid(), { groupId, remark });
    return { state: 'accepted' };
  }

  async pin(target: PeerPreferenceTarget, enabled: boolean): Promise<AccountWriteOutcome> {
    if (target.kind === 'c2c') await this.friend(target.uid);
    await SetPeerPin.invoke(this.nt, this.resolvePid(), { target, enabled });
    return { state: 'accepted' };
  }

  async friendDisturb(uid: string, enabled: boolean): Promise<AccountWriteOutcome> {
    await this.friend(uid);
    const state = await SetFriendDisturb.invoke(this.nt, this.resolvePid(), { uid, enabled });
    return { state };
  }

  async getFriendDisturb(uid: string): Promise<{ uid: string; enabled: boolean | null }> {
    const row = await this.friendSns(uid);
    return { uid, enabled: row.disturbPresent ? row.disturb : false };
  }

  async getFriendSpecialCare(uid: string) {
    const row = await this.friendSns(uid);
    const state = row.specialCare;
    return {
      uid,
      enabled: state.enabledPresent ? state.enabled : false,
      zone: state.zonePresent ? state.zone : false,
      ring: state.ringPresent ? state.ring : false,
    };
  }

  async friendSpecialCare(uid: string, enabled: boolean): Promise<AccountWriteOutcome> {
    const pid = this.resolvePid();
    // 先读取原态，不能因 ACK 未知或超时自动重放写请求。
    await this.getFriendSpecialCare(uid);
    this.assertCurrentPid(pid);
    try {
      await SetFriendSpecialCare.invoke(this.nt, pid, { uid, enabled });
    } catch {
      this.assertCurrentPid(pid);
      return { state: 'unconfirmed' };
    }
    this.assertCurrentPid(pid);
    return { state: 'unconfirmed' };
  }

  private async friendSns(
    uid: string,
    includeDirectory = false,
    includeRemark = false,
  ): Promise<FriendSnsPage['friends'][number]> {
    const buddy = await this.friend(uid);
    if (buddy.uid !== uid) throw new Error('好友资料与读取目标不一致');
    const result = await this.friendRoster(includeDirectory, includeRemark);
    const found = result.friends.find((row) => row.uid === uid);
    if (!found) throw new Error('云端好友名册中没有读取目标');
    if (found.uin !== String(buddy.uin)) throw new Error('好友名册与读取目标不一致');
    return found;
  }

  async friendRoster(includeDirectory = true, includeRemark = false) {
    const pid = this.resolvePid();
    const seen = new Set<string>();
    const cookies = new Set<string>();
    let cookie: Uint8Array | undefined;
    const friends: FriendSnsPage['friends'] = [];
    const categories = new Map<string, NonNullable<FriendSnsPage['categories']>[number]>();
    let categoriesPresent = false;
    for (let page = 0; page < 100; page++) {
      this.assertCurrentPid(pid);
      const result = await GetFriendSnsPage.invoke(this.nt, pid, {
        cookie,
        includeDirectory,
        includeRemark,
      });
      this.assertCurrentPid(pid);
      if (result.selfUin !== undefined && result.selfUin !== this.identity.uin)
        throw new Error('好友名册与当前账号不一致');
      for (const row of result.friends) {
        if (seen.has(row.uid)) throw new Error('好友名册分页返回重复目标，请重新读取');
        seen.add(row.uid);
        friends.push(row);
      }
      if (result.categories !== undefined) categoriesPresent = true;
      for (const row of result.categories ?? []) {
        const key = row.id === null ? `missing:${row.name}:${row.sortOrder}` : String(row.id);
        const previous = categories.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(row))
          throw new Error('好友分组目录分页不一致');
        categories.set(key, row);
      }
      cookie = result.cookie;
      if (result.isEnd === false && !cookie?.length)
        throw new Error('好友名册尚未结束，但未返回下一页游标');
      // 只有完整请求全部走完，缺省 SNS 才能按已验证的关闭响应处理。
      if (result.isEnd === true || !cookie?.length) {
        if (!includeDirectory) return { friends, categories: null };
        const rawCategories = [...categories.values()];
        const local = rawCategories.some((row) => row.id === null)
          ? await this.identity.listCategories()
          : [];
        this.assertCurrentPid(pid);
        const missing = rawCategories.filter((row) => row.id === null);
        const resolved = rawCategories.map((row) => {
          if (row.id !== null) return { ...row, id: row.id, idPresent: true };
          // 只在完整名册中关联同账号本地默认组；不将任意缺失 ID 普遍补零。
          const candidates = local.filter((entry) => entry.id === 0 && entry.name === row.name);
          const memberCount = friends.filter((friend) => (friend.categoryId ?? 0) === 0).length;
          if (
            missing.length !== 1 ||
            rawCategories.some((entry) => entry.id === 0) ||
            candidates.length !== 1 ||
            (row.buddyCount !== null && row.buddyCount !== memberCount)
          )
            throw new Error('分组目录缺少可确认的 ID，请刷新本地联系人后重试');
          return { ...row, id: 0, idPresent: false };
        });
        const normalizedFriends = friends.map((row) =>
          row.categoryId === undefined
            ? { ...row, categoryId: 0, categoryIdPresent: false }
            : { ...row, categoryIdPresent: true },
        );
        return { friends: normalizedFriends, categories: categoriesPresent ? resolved : null };
      }
      const key = Buffer.from(cookie).toString('base64');
      if (cookies.has(key)) throw new Error('好友名册分页游标循环');
      cookies.add(key);
    }
    throw new Error('好友名册分页超过读取上限');
  }

  async groupMessagePolicy(
    groupId: number,
    policy: GroupMessagePolicy,
  ): Promise<AccountWriteOutcome> {
    await SetGroupMessagePolicy.invoke(this.nt, this.resolvePid(), {
      groupId,
      selfUid: this.identity.selfUid,
      policy,
    });
    return { state: 'accepted' };
  }

  async friendCategory(uid: string, categoryId: number): Promise<AccountWriteOutcome> {
    await this.friend(uid);
    return this.manageFriendCategories({ type: 'move', uids: [uid], categoryId });
  }

  async manageFriendCategories(
    operation:
      | { type: 'create'; name: string }
      | { type: 'rename'; id: number; name: string }
      | { type: 'sort'; ids: number[] }
      | { type: 'delete'; id: number; mergeInto?: number }
      | { type: 'move'; uids: string[]; categoryId: number },
  ): Promise<AccountWriteOutcome> {
    const pid = this.resolvePid();
    const before = await this.friendRoster();
    this.assertCurrentPid(pid);
    if (!before.categories) throw new Error('云端未返回分组目录，请稍后重读');
    const categories = before.categories;
    const hasCategory = (id: number) => id === 0 || categories.some((row) => row.id === id);
    const write = async (action: () => Promise<unknown>) => {
      this.assertCurrentPid(pid);
      try {
        await action();
      } catch {
        throw new Error('分组操作结果待核对，请刷新后检查；不会自动重发请求');
      }
      this.assertCurrentPid(pid);
    };
    if (operation.type === 'create') {
      await write(() => CreateFriendCategory.invoke(this.nt, pid, operation));
    } else if (operation.type === 'rename') {
      if (!hasCategory(operation.id)) throw new Error('分组已不存在');
      await write(() =>
        UpdateFriendCategories.invoke(this.nt, pid, {
          categories: [{ id: operation.id, name: operation.name }],
        }),
      );
    } else if (operation.type === 'sort') {
      const ids = categories.map((row) => row.id);
      if (
        operation.ids.length !== ids.length ||
        new Set(operation.ids).size !== ids.length ||
        operation.ids.some((id) => !ids.includes(id))
      )
        throw new Error('分组目录已变化，请刷新后重排');
      await write(() =>
        UpdateFriendCategories.invoke(this.nt, pid, {
          categories: operation.ids.map((id, sort) => ({ id, sort })),
        }),
      );
    } else {
      const target = operation.type === 'move' ? operation.categoryId : operation.mergeInto;
      if (operation.type === 'move' && !hasCategory(operation.categoryId))
        throw new Error('目标好友分组不存在');
      if (operation.type === 'delete' && (!operation.id || !hasCategory(operation.id)))
        throw new Error('不能删除默认分组或不存在的分组');
      const members =
        operation.type === 'move'
          ? operation.uids.map((uid) => {
              const friend = before.friends.find((row) => row.uid === uid);
              if (!friend) throw new Error('部分目标已不是好友，请刷新后重试');
              return friend;
            })
          : before.friends.filter((row) => row.categoryId === operation.id);
      if (before.friends.some((row) => row.categoryId === undefined))
        throw new Error('好友名册缺少分组信息，不能安全移组或删除');
      if (
        members.length &&
        (target === undefined ||
          !hasCategory(target) ||
          (operation.type === 'delete' && target === operation.id))
      )
        throw new Error('请选择有效的合并目标分组');
      for (const friend of members) {
        if (target === undefined || friend.categoryId === target) continue;
        await write(() =>
          MoveFriendCategory.invoke(this.nt, pid, { uid: friend.uid, categoryId: target }),
        );
        const observed = await this.friendSns(friend.uid, true);
        this.assertCurrentPid(pid);
        if (observed.categoryId !== target)
          throw new Error('部分好友移组尚未确认，已停止后续操作，请刷新后核对');
      }
      if (operation.type === 'delete') {
        const current = await this.friendRoster();
        this.assertCurrentPid(pid);
        if (
          current.friends.some(
            (row) => row.categoryId === undefined || row.categoryId === operation.id,
          )
        )
          throw new Error('分组仍有好友或状态未知，未删除分组');
        await write(() => DeleteFriendCategory.invoke(this.nt, pid, { categoryId: operation.id }));
      }
    }
    const after = await this.friendRoster();
    this.assertCurrentPid(pid);
    if (!after.categories) return { state: 'unconfirmed' };
    const confirmed =
      operation.type === 'create'
        ? after.categories.some(
            (row) => row.name === operation.name && !categories.some((old) => old.id === row.id),
          )
        : operation.type === 'rename'
          ? after.categories.some((row) => row.id === operation.id && row.name === operation.name)
          : operation.type === 'delete'
            ? !after.categories.some((row) => row.id === operation.id)
            : operation.type === 'move'
              ? operation.uids.every((uid) =>
                  after.friends.some(
                    (row) => row.uid === uid && row.categoryId === operation.categoryId,
                  ),
                )
              : [...after.categories]
                  .sort((a, b) => (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity))
                  .map((row) => row.id)
                  .join(',') === operation.ids.join(',');
    return { state: confirmed ? 'confirmed' : 'unconfirmed' };
  }

  async selfProfile(patch: SelfProfilePatch): Promise<AccountWriteOutcome> {
    await SetSelfProfile.invoke(this.nt, this.resolvePid(), { ...patch, uin: this.identity.uin });
    return { state: 'accepted' };
  }

  async onlineStatus(params: SetOnlineStatusParams): Promise<AccountWriteOutcome> {
    await SetOnlineStatus.invoke(this.nt, this.resolvePid(), params);
    return { state: 'accepted' };
  }

  async selfAvatar(source: string): Promise<AccountWriteOutcome> {
    const pid = this.resolvePid();
    await setSelfAvatar(this.nt, pid, {
      uin: this.identity.uin,
      source,
      beforeSend: () => this.assertCurrentPid(pid),
    });
    return { state: 'accepted' };
  }

  async groupAvatar(groupId: number, source: string): Promise<AccountWriteOutcome> {
    const pid = this.resolvePid();
    await setGroupAvatar(this.nt, pid, {
      groupId,
      uin: this.identity.uin,
      source,
      beforeSend: () => this.assertCurrentPid(pid),
    });
    return { state: 'accepted' };
  }
  private assertCurrentPid(pid: number): void {
    if (this.resolvePid() !== pid) throw new Error('QQ 运行时已切换，请重新操作');
  }
}
