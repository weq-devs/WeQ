/**
 * `@weq/protocol` — protobuf (de)serialization + custom-packet transport over
 * the native QQ hook.
 *
 *   protobuf.ts           — runtime, schema-driven protobuf encode/decode (no build step).
 *   transport.ts          — sendOidb / sendPacket wrappers around the native addon.
 *   sign/whitelist.ts     — 签名策略：按 LagrangeV2 WhiteListCommand 推导 needSign。
 *   oidb/invoke.ts        — invokeOidb / invokeTrpc dispatchers + spec shapes.
 *   oidb/shared.ts        — toInt / ensureRetCodeZero / hex utils.
 *   oidb/media-schemas.ts — NTV2 + file + album proto schemas + MediaIndexNode.
 *   oidb/ntv2.ts          — buildNtv2DownloadReq / parseNtv2DownloadUrl.
 *
 * 业务 spec 按域分目录，每个目录的 `index.ts` 显式 re-export：
 *   oidb/group-admin/   — 改名 / 管理员 / 群名片 / 头衔 / 精华 / 头像 / 禁言 / 踢人
 *   oidb/group-file/    — 群文件列表 / 下载地址 / 文件与文件夹操作
 *   oidb/group-album/   — 群相册媒体列表与写操作
 *   oidb/interaction/   — 戳一戳 / 贴表情 / 表情回应人
 *   oidb/request/       — 加群 / 好友 / 可疑好友申请
 *   oidb/profile/       — QQ 等级 / QQ 秀 / 资料卡赞 / 在线与输入状态 / 资料
 *   oidb/custom-face/   — 收藏表情（Faceroam）
 *   oidb/group-todo/    — 群待办
 *   oidb/misc/          — OCR / 解密密钥 / clientKey / rkey / pskey / Ark / AI 语音 / 群报名
 *   redbag/             — QQ 红包：口令池 (SsoGetToken) + hb_pc_pre_pack（sso_handle 加密壳 + 二维码/领取 token）。
 *   scupdate/           — 个性装扮资源(气泡/字体)的下载地址获取(见该目录 index)。
 *   highway/            — 闪传/富媒体传输层(流式哈希 + sliceupload 直传)。
 *   oidb/flashtransfer/ — 闪传 fileset OIDB 服务 + 上传编排。
 */

export { encode, decode, message } from './protobuf';
export type { ProtoMessage, ProtoField, ScalarType } from './protobuf';

export { sendOidb, sendPacket } from './transport';
export type { PacketNative, OidbNative, TrpcNative, OidbRequest } from './transport';

export { invokeOidb, invokeTrpc } from './oidb/invoke';
export type { OidbSpec, TrpcSpec } from './oidb/invoke';
export { commandNeedsSign, oidbNeedsSign, oidbWireCommand } from './sign/whitelist';

export {
  toInt,
  ensureRetCodeZero,
  bytesToHex,
  bytesToHexUpper,
  cleanNtLocalPath,
} from './oidb/shared';

export { normalizeMediaNode } from './oidb/media-schemas';
export type { MediaIndexNode } from './oidb/media-schemas';

// ───────────────────── OIDB / trpc 业务 spec（按域分组） ─────────────────────

export * from './oidb/group-admin';
export * from './oidb/group-file';
export * from './oidb/group-album';
export * from './oidb/group-todo';
export * from './oidb/custom-face';
export * from './oidb/interaction';
export * from './oidb/request';
export * from './oidb/profile';
export * from './oidb/misc';
// 桌面端写接口继续使用带账号复核和图片校验的头像上传路径。
export {
  setSelfAvatar,
  SELF_AVATAR_HIGHWAY_CMD,
  AVATAR_MAX_BYTES,
} from './oidb/group-admin/set-group-avatar';
export type { SetSelfAvatarParams } from './oidb/group-admin/set-group-avatar';
export {
  RedBagDetail,
  RedBagGrab,
  decodeSsoHandlePacket,
  encodeSsoHandleRequest,
  fetchTenpayPsKey,
  prePackRedBag,
  RedBagPasswordPool,
  RedBagPrePack,
  RED_BAG_PSKEY_DOMAIN,
  RED_BAG_SALT_BYTES,
} from './redbag';
export type {
  RedBagClaim,
  RedBagDetailResult,
  RedBagDetailSummary,
  RedBagGrabResult,
  RedBagKind,
  RedBagLocateParams,
  RedBagPacketView,
  RedBagPeerType,
  RedBagPrePackParams,
  RedBagPrePackResult,
  RedBagSplit,
} from './redbag';
export { signRedBagRequest, RED_BAG_SIGN_SALT1, RED_BAG_SIGN_SALT2 } from './redbag/sign';
export {
  decryptRedBagPayload,
  deriveRedBagIv,
  deriveRedBagKey,
  encryptRedBagPayload,
  RED_BAG_IV_MATERIAL,
  RED_BAG_KEY_MATERIAL,
  RED_BAG_SALT_LENGTH,
} from './redbag/crypto';
export {
  RED_BAG_DETAIL_BODY,
  RED_BAG_DETAIL_CMD,
  RED_BAG_DETAIL_QUERY,
  RED_BAG_DETAIL_REQ,
  RED_BAG_DETAIL_RESP,
  RED_BAG_GRAB_BODY,
  RED_BAG_GRAB_CMD,
  RED_BAG_GRAB_QUERY,
  RED_BAG_GRAB_REQ,
  RED_BAG_GRAB_RESP,
  RED_BAG_KIND,
  RED_BAG_PASSWORD_POOL_CMD,
  RED_BAG_PASSWORD_POOL_REQ,
  RED_BAG_PASSWORD_POOL_RESP,
  RED_BAG_PRE_PACK_CMD,
  RED_BAG_PRE_PACK_REQ,
  RED_BAG_PRE_PACK_RESP,
  RED_BAG_REQ_ENVELOPE,
  RED_BAG_RESP_ENVELOPE,
  RED_BAG_SCENE,
  RED_BAG_SPLIT,
  RED_BAG_SSO_HANDLE_CMD,
} from './redbag/schemas';

export * from './scupdate';
export * from './highway';
export * from './oidb/flashtransfer';

export * from './msg';
export * from './file';

export {
  PttTrans,
  C2C_PTT_TRANS_CMD,
  GROUP_PTT_TRANS_CMD,
  PTT_TRANS_PUSH_MSG_TYPE,
  PTT_TRANS_PUSH_SUB_TYPE,
  PTT_TRANS_REQ,
  PTT_TRANS_RESP,
  PTT_TRANS_RESULT,
  PTT_TRANS_PUSH,
  PTT_TRANS_PUSH_ITEM,
  C2C_PTT_TRANS_ITEM,
  GROUP_PTT_TRANS_ITEM,
  buildPttTransReq,
  encodePttTransReq,
  parsePttTransAck,
  parsePttTransPush,
  pttTransCmd,
} from './ptt-trans';
export type { PttTransVoice, PttTransAck, PttTransPush } from './ptt-trans';
export { ReportRead, type ReadReportParams } from './msg/report-read';
export { SetFriendRemark, ClearFriendRemark } from './oidb/set-friend-remark';
export type { SetFriendRemarkParams } from './oidb/set-friend-remark';
export { SetGroupRemark } from './oidb/set-group-remark';
export type { SetGroupRemarkParams } from './oidb/set-group-remark';
export { SetFriendCategory } from './oidb/set-friend-category';
export type { SetFriendCategoryParams } from './oidb/set-friend-category';
export { GetFriendSnsPage, type FriendSnsPage } from './oidb/get-friend-sns';
export {
  getCloudProfile,
  getCommonFriendCount,
  getCommonGroups,
  cloudProfileResponse,
  commonGroupsResponse,
} from './oidb/profile/cloud-profile';
export {
  QQ_REGIONS,
  QQ_PROFESSIONS,
  readEditableProfile,
  writeEditableProfile,
  packQqRegionCode,
  encodeQqRegion,
  packQqBirthday,
  parseLegacyProfileBody,
  encodeEditableProfile,
  type EditableProfilePatch,
} from './oidb/profile/editable-profile';
export {
  CreateFriendCategory,
  UpdateFriendCategories,
  DeleteFriendCategory,
  MoveFriendCategory,
} from './oidb/manage-friend-category';
export {
  SetFriendSpecialCare,
  SNS_SPECIAL_CARE,
  SNS_SPECIAL_CARE_ZONE,
  SNS_SPECIAL_CARE_RING,
} from './oidb/set-friend-special-care';
export {
  GetGroupIdentity,
  SetGroupIdentity,
  type GroupIdentitySnapshot,
  type GroupIdentityTitle,
} from './oidb/group-identity';
export {
  SetPeerPin,
  SetFriendDisturb,
  SetGroupMessagePolicy,
  GROUP_MESSAGE_POLICIES,
  SNS_FRIEND_PIN,
  SNS_GROUP_PIN,
  SNS_FRIEND_DISTURB,
} from './oidb/set-peer-preference';
export type {
  PeerPreferenceTarget,
  SetPeerPinParams,
  SetFriendDisturbParams,
  GroupMessagePolicy,
  SetGroupMessagePolicyParams,
} from './oidb/set-peer-preference';
export {
  SetSelfProfile,
  PROFILE_NICKNAME,
  PROFILE_SIGNATURE,
  PROFILE_GENDER,
} from './oidb/set-self-profile';
export type {
  SelfProfilePatch,
  SetSelfProfileParams,
} from './oidb/set-self-profile';

export * from './call';
