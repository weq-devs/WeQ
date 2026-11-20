export type QQGroupRole = 'owner' | 'admin' | 'member';
export type QQGroupOperation =
  | 'recall'
  | 'card'
  | 'mute'
  | 'kick'
  | 'kickReject'
  | 'admin'
  | 'title'
  | 'name'
  | 'essenceSet'
  | 'essenceRemove'
  | 'fileDelete'
  | 'fileRename'
  | 'fileMove'
  | 'folder'
  | 'fileUpload'
  | 'speak'
  | 'manage';

export interface QQGroupPermissionContext {
  role?: QQGroupRole | null;
  targetRole?: QQGroupRole | null;
  isSelf?: boolean;
  owned?: boolean;
  recallAllowed?: boolean | null;
  adminKickAllowed?: boolean | null;
  temporaryRecall?: boolean;
  allowMemberKick?: boolean | null;
  memberCanRename?: boolean | null;
  memberCanEssence?: boolean | null;
  memberCanUpload?: boolean | null;
  canRemove?: boolean | null;
  muteAll?: boolean | null;
  /** Unix 秒，使用时重新比较，不保存过期的布尔禁言状态。 */
  muteUntil?: number | null;
  now?: number;
}

/** 浏览器、桌面、服务端及 OneBot 共用；各动作明确保留不同的目标/能力规则。 */
export function groupPermission(action: QQGroupOperation, c: QQGroupPermissionContext): boolean {
  const owner = c.role === 'owner';
  const manager = owner || c.role === 'admin';
  const lower = c.targetRole === 'member' || (owner && c.targetRole === 'admin');
  switch (action) {
    case 'recall':
      return (
        owner ||
        (c.recallAllowed !== false &&
          (c.role === 'admin' || c.temporaryRecall === true) &&
          c.targetRole === 'member')
      );
    case 'card':
      return (
        c.isSelf === true ||
        owner ||
        (c.role === 'admin' && (c.targetRole === 'admin' || c.targetRole === 'member'))
      );
    case 'mute':
      return !c.isSelf && manager && lower;
    case 'kick':
      return (
        !c.isSelf &&
        ((owner && lower) ||
          (((c.role === 'admin' && c.adminKickAllowed !== false) ||
            (c.role === 'member' && c.allowMemberKick === true)) &&
            c.targetRole === 'member'))
      );
    case 'kickReject':
      return !c.isSelf && manager && lower && (owner || c.adminKickAllowed !== false);
    case 'admin':
      return !c.isSelf && owner && lower;
    case 'title':
      return owner;
    case 'name':
      return manager || (c.role === 'member' && c.memberCanRename === true);
    case 'essenceSet':
      return manager || (c.role === 'member' && c.memberCanEssence === true);
    case 'essenceRemove':
      return c.canRemove != null
        ? c.canRemove
        : c.isSelf === true || groupPermission('essenceSet', c);
    case 'fileDelete':
    case 'fileRename':
      return manager || c.owned === true;
    case 'fileMove':
    case 'folder':
    case 'manage':
      return manager;
    case 'fileUpload':
      return manager || (c.role === 'member' && c.memberCanUpload !== false);
    case 'speak':
      return (
        (c.muteUntil == null || c.muteUntil <= (c.now ?? Date.now() / 1000)) &&
        (manager || c.muteAll !== true)
      );
  }
}

export function isTemporaryGroupFile(file: { fileId: string; busId: number; expireTime: number }) {
  return (
    !!file.fileId &&
    file.busId === 102 &&
    Number.isSafeInteger(file.expireTime) &&
    file.expireTime > Date.now() / 1000
  );
}

export function qqResourceOwnedBy(
  owner: string | number | bigint | null | undefined,
  self: { uid?: string | null; uin?: string | number | bigint | null },
): boolean {
  const id = String(owner ?? '');
  return /^u_[A-Za-z0-9_-]+$/.test(id)
    ? id === self.uid
    : /^[1-9]\d*$/.test(id) && id === String(self.uin ?? '');
}

export interface QQRecallPermissionInput extends QQGroupPermissionContext {
  kind: 'c2c' | 'group';
  mine: boolean;
  file?: boolean;
  ageMs?: number;
}

export interface QQAlbumCapabilities {
  create: boolean;
  modify: boolean;
  upload: boolean;
  deleteMedia: boolean;
  top: boolean;
  deleteAlbum: boolean;
}

/** Android QunMediaRightEnum 的 ordinal 列表，不能按位运算。缺少整项返回时保留未知。 */
export function albumCapabilities(
  operations: readonly number[] | null,
): QQAlbumCapabilities | null {
  if (operations === null) return null;
  return {
    create: operations.includes(1),
    modify: operations.includes(2),
    upload: operations.includes(3),
    deleteMedia: operations.includes(4),
    top: operations.includes(5),
    deleteAlbum: operations.includes(6),
  };
}

export function albumMediaDeleteAllowed(
  capabilities: QQAlbumCapabilities | null | undefined,
  owned: boolean,
): boolean {
  // Android 当前媒体删除入口使用 DELETEALBUM，而不是名字相近的 DELETEMEDIA。
  return owned || capabilities?.deleteAlbum === true;
}

/** null 表示本地规则允许；未知的本人服务端窗口不改成臆测的固定上限。 */
export function recallPermission(c: QQRecallPermissionInput): string | null {
  if (!c.mine && (c.kind !== 'group' || !groupPermission('recall', c)))
    return c.kind === 'group' && c.targetRole == null
      ? '发送者身份尚未确认'
      : '当前账号不能撤回这位成员的消息';
  if (
    c.kind === 'group' &&
    (c.role === 'owner' || c.role === 'admin' || (!c.mine && c.temporaryRecall))
  )
    return null;
  const hours = c.kind === 'c2c' && c.file === true;
  if (c.ageMs !== undefined && c.ageMs > (hours ? 7_200_000 : 120_000))
    return hours ? '超过 2 小时的私聊文件无法撤回' : '超过 2 分钟的消息无法撤回';
  return null;
}
