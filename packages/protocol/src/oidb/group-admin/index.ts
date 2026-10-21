/** 群管理：改名 / 管理员 / 群名片 / 头衔 / 精华 / 头像 / 禁言 / 踢人。 */
export { GetGroupMessagePolicies } from './get-group-message-policies';
export type { GroupMessagePolicySnapshot } from './get-group-message-policies';
export { SetGroupName } from './set-group-name';
export type { SetGroupNameParams } from './set-group-name';
export { SetGroupAdmin } from './set-group-admin';
export type { SetGroupAdminParams } from './set-group-admin';
export { SetGroupMemberCard } from './set-group-member-card';
export type { SetGroupMemberCardParams } from './set-group-member-card';
export { SetGroupSpecialTitle, SPECIAL_TITLE_PERMANENT } from './set-group-special-title';
export type { SetGroupSpecialTitleParams } from './set-group-special-title';
export { SetGroupEssence } from './set-group-essence';
export type { SetGroupEssenceParams } from './set-group-essence';
export {
  GROUP_AVATAR_HIGHWAY_CMD,
  encodeGroupAvatarExtra,
  setGroupAvatar,
} from './set-group-avatar';
export type { SetGroupAvatarParams } from './set-group-avatar';
export { MuteGroupAll, MUTE_ALL_PERMANENT } from './mute-group-all';
export type { MuteGroupAllParams } from './mute-group-all';
export { MuteGroupMember } from './mute-group-member';
export type { MuteGroupMemberParams } from './mute-group-member';
export { KickGroupMember } from './kick-group-member';
export type { KickGroupMemberParams } from './kick-group-member';

export {
  LeaveGroup,
  SetGroupAddOption,
  isQuestionAddType,
  wireAddType,
  GetGroupAtAllRemain,
  GetGroupCategoryTags,
  AddGroupCategoryTag,
  DeleteGroupCategoryTag,
  FetchGroupMemberListPage,
} from './group-settings';
export type {
  LeaveGroupParams,
  SetGroupAddOptionParams,
  AtAllRemain,
  GetGroupAtAllRemainParams,
  GroupCategoryTag,
  GroupCategoryParams,
  ChangeGroupCategoryTagParams,
  GroupMemberListItem,
  GroupMemberListPage,
  FetchGroupMemberListParams,
} from './group-settings';
