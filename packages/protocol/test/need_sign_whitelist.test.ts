/**
 * 签名白名单回归测试。
 *
 * 规则（2026-10-19 起）：`invokeOidb` / `invokeTrpc` 在 spec **未显式标注**
 * `needSign` 时，按 LagrangeV2 的 `WhiteListCommand`（`../LagrangeV2/Lagrange.Core/
 * Common/BotSignProvider.cs`）推导 —— 名单里没有的命令**不签**，多签不是好事。
 * 显式标注只用于两种已核实情形：命令在名单里但抓包确认不该签（如 0x929b_0 /
 * 0xdc2_34），或 native 实际发出的 wire 名与名单写法不一致（如 0x6d6_0 只以
 * `OidbSvc.` 形式出现）。
 *
 * 这里同时断言「白名单推导结果」和「最终生效值」，后者覆盖显式覆盖项。
 */

import { describe, expect, it } from 'vitest';
import { commandNeedsSign, oidbNeedsSign, oidbWireCommand } from '../src/sign/whitelist';
import {
  ApplyFileset,
  ApplyUpload,
  CommitFile,
  CompleteFileset,
  FetchClientKey,
  FetchDownloadRkeys,
  FetchPskeyOidb,
  GetAlbumMediaList,
  GetC2cHistory,
  GetEmojiLikes,
  GetFilesetDetail,
  GetGroupFileUrl,
  GetGroupHistory,
  GetGroupPttUrl,
  GetGroupVideoUrl,
  GetPrivateFileUrl,
  GetPrivatePttUrl,
  GetPrivateVideoUrl,
  GetProfileLike,
  GetQqShowUrl,
  GetUserQqLevel,
  KickGroupMember,
  ListGroupFiles,
  MuteGroupAll,
  MuteGroupMember,
  OcrImage,
  PrepareUpload,
  RequestDecryptKey,
  LeaveGroup,
  SetGroupAddOption,
  GetGroupAtAllRemain,
  GetGroupCategoryTags,
  AddGroupCategoryTag,
  DeleteGroupCategoryTag,
  FetchGroupMemberListPage,
  DeleteGroupFile,
  RenameGroupFile,
  MoveGroupFile,
  CreateGroupFolder,
  DeleteGroupFolder,
  RenameGroupFolder,
  GetGroupFileCount,
  GetGroupFileSpace,
  GroupTodo,
  GetGroupTodoList,
  SendGroupSign,
  ClickInlineKeyboardButton,
  SetProfile,
  SetSelfLongNick,
  SetInputStatus,
  GetUserOnlineStatus,
  HandleFriendRequest,
  FetchDoubtFriendRequests,
  RejectDoubtFriendRequest,
  ApproveDoubtFriendRequest,
  SetGroupRequest,
  FetchCustomFaceList,
  DeleteCustomFace,
  FetchCustomFaceDetail,
  ModifyCustomFace,
  MoveCustomFace,
  OrderCustomFace,
  DeleteGroupAlbumMedia,
  SetGroupAlbumLike,
  GetGroupAlbumFeedDetail,
  CommentGroupAlbumMedia,
  SendAiVoice,
  SendGroupJoinRequest,
  SendGroupSignup,
  SendLocationArk,
  SendPoke,
  SendTuwenArk,
  SetFilesetStatus,
  SetGroupAdmin,
  SetGroupEssence,
  SetGroupMemberCard,
  SetGroupName,
  SetGroupSpecialTitle,
  SetReaction,
  FetchGroupRequests,
  SetOnlineStatus,
  SetDiyOnlineStatus,
  ReadedReport,
} from '../src/index';

/** `[spec 名, spec, 期望最终 needSign, 期望来源]` */
const OIDB_CASES: [
  string,
  { command: number; subCommand?: number; needSign?: boolean },
  boolean,
  string,
][] = [
  // ── 白名单内 ──
  ['SetGroupName', SetGroupName, true, '白名单 0x89a_15'],
  ['SetGroupMemberCard', SetGroupMemberCard, true, '白名单 0x8fc_3'],
  ['MuteGroupAll', MuteGroupAll, true, '白名单 0x89a_0'],
  ['SendGroupJoinRequest', SendGroupJoinRequest, true, '白名单 0x11ec_1'],
  ['FetchClientKey', FetchClientKey, true, '白名单 0x102a_1（显式）'],
  ['FetchPskeyOidb', FetchPskeyOidb, true, '白名单 0x102a_0（显式）'],
  ['GetUserQqLevel', GetUserQqLevel, true, '白名单 0xfe1_2'],
  ['GetGroupFileUrl', GetGroupFileUrl, true, '白名单 0x6d6_2'],
  ['GetPrivateFileUrl', GetPrivateFileUrl, true, '白名单 0xe37_1200'],
  ['GetGroupPttUrl', GetGroupPttUrl, true, '白名单 0x126e_200'],
  ['GetPrivatePttUrl', GetPrivatePttUrl, true, '白名单 0x126d_200'],
  ['GetGroupVideoUrl', GetGroupVideoUrl, true, '白名单 0x11ea_200'],
  ['GetPrivateVideoUrl', GetPrivateVideoUrl, true, '白名单 0x11e9_200'],

  // ── 白名单外，未显式标注 → 推导为不签 ──
  ['GetProfileLike', GetProfileLike, false, '0x7ed_12 不在白名单'],
  ['SendPoke', SendPoke, false, '0xed3_1 不在白名单'],
  ['GetQqShowUrl', GetQqShowUrl, false, '0xfe1_3 不在白名单'],
  ['FetchDownloadRkeys', FetchDownloadRkeys, false, '0x9067_202 不在白名单'],
  ['PrepareUpload', PrepareUpload, false, '0x12a9_100 不在白名单'],
  ['ApplyUpload', ApplyUpload, false, '0x12a9_103 不在白名单'],
  ['ApplyFileset', ApplyFileset, false, '0x93cf_1 不在白名单'],
  ['CommitFile', CommitFile, false, '0x93d0_1 不在白名单'],
  ['SetFilesetStatus', SetFilesetStatus, false, '0x93d1_1 不在白名单'],
  ['GetFilesetDetail', GetFilesetDetail, false, '0x93d3_1 不在白名单'],
  ['CompleteFileset', CompleteFileset, false, '0x93db_1 不在白名单'],
  ['GetEmojiLikes', GetEmojiLikes, false, '0x9083_1 不在白名单'],
  ['SetReaction', SetReaction, false, '0x9082 不在白名单'],
  ['OcrImage', OcrImage, false, '0xe07_0 不在白名单'],
  ['RequestDecryptKey', RequestDecryptKey, false, '0xcde_2 不在白名单'],
  ['MuteGroupMember', MuteGroupMember, false, '0x1253_1 不在白名单'],
  ['KickGroupMember', KickGroupMember, false, '0x8a0_1 不在白名单'],
  ['SetGroupAdmin', SetGroupAdmin, false, '0x1096_1 不在白名单'],
  ['SetGroupEssence', SetGroupEssence, false, '0xeac 不在白名单'],
  ['SetGroupSpecialTitle', SetGroupSpecialTitle, false, '0x8fc_2 不在白名单'],
  ['SendGroupSignup', SendGroupSignup, false, '0x921b_0 不在白名单'],
  ['ListGroupFiles', ListGroupFiles, false, '0x6d8_1 不在白名单'],

  // ── 本次新增：白名单内 ──
  ['SetGroupRequest', SetGroupRequest, true, '白名单 0x10c8_1/2'],
  ['FetchGroupMemberListPage', FetchGroupMemberListPage, true, '白名单 0xfe7_3'],
  ['DeleteGroupFile', DeleteGroupFile, true, '白名单 0x6d6_3'],
  ['ClickInlineKeyboardButton', ClickInlineKeyboardButton, true, '白名单 0x112e_1'],
  ['SetProfile', SetProfile, true, '白名单 0x112a_2'],
  ['SetSelfLongNick', SetSelfLongNick, true, '白名单 0x112a_2'],
  ['FetchCustomFaceDetail', FetchCustomFaceDetail, true, '白名单 0x902e_1'],
  ['ModifyCustomFace', ModifyCustomFace, true, '白名单 0x902e_1'],
  ['MoveCustomFace', MoveCustomFace, true, '白名单 0x902e_1'],
  ['SetGroupAddOption', SetGroupAddOption, true, '白名单 0x89a_0'],
  ['FetchGroupRequests', FetchGroupRequests, true, '白名单 0x10c0_1/2'],
  ['GetUserOnlineStatus', GetUserOnlineStatus, true, '白名单 0xfe1_2'],

  // ── 本次新增：白名单外 ──
  ['LeaveGroup', LeaveGroup, false, '0x1097_1 不在白名单'],
  ['GetGroupAtAllRemain', GetGroupAtAllRemain, false, '0x8a7_0 不在白名单'],
  ['GetGroupCategoryTags', GetGroupCategoryTags, false, '0x967c_0 不在白名单'],
  ['AddGroupCategoryTag', AddGroupCategoryTag, false, '0x967d_0 不在白名单'],
  ['DeleteGroupCategoryTag', DeleteGroupCategoryTag, false, '0x967e_0 不在白名单'],
  ['RenameGroupFile', RenameGroupFile, false, '0x6d6_4 不在白名单'],
  ['MoveGroupFile', MoveGroupFile, false, '0x6d6_5 不在白名单'],
  ['CreateGroupFolder', CreateGroupFolder, false, '0x6d7_0 只有 OidbSvc. 写法'],
  ['DeleteGroupFolder', DeleteGroupFolder, false, '0x6d7_1 不在白名单'],
  ['RenameGroupFolder', RenameGroupFolder, false, '0x6d7_2 不在白名单'],
  ['GetGroupFileCount', GetGroupFileCount, false, '0x6d8_2 不在白名单'],
  ['GetGroupFileSpace', GetGroupFileSpace, false, '0x6d8_3 不在白名单'],
  ['GroupTodo', GroupTodo, false, '0xf90 不在白名单'],
  ['GetGroupTodoList', GetGroupTodoList, false, '0x9474 不在白名单'],
  ['SendGroupSign', SendGroupSign, false, '0xeb7 不在白名单'],
  ['SetInputStatus', SetInputStatus, false, '0xcd4 不在白名单'],
  ['HandleFriendRequest', HandleFriendRequest, false, '0xb5d 不在白名单'],
  ['FetchDoubtFriendRequests', FetchDoubtFriendRequests, false, '0xd69 不在白名单'],
  ['RejectDoubtFriendRequest', RejectDoubtFriendRequest, false, '0xd69 不在白名单'],
  ['ApproveDoubtFriendRequest', ApproveDoubtFriendRequest, false, '0xd72 不在白名单'],
  ['OrderCustomFace', OrderCustomFace, false, '0x902f_1 不在白名单'],

  // ── 显式覆盖：在名单里但抓包确认不签 ──
  ['SendAiVoice', SendAiVoice, false, '0x929b_0 在名单但抓包不带 tag 24（显式覆盖）'],
  ['SendTuwenArk', SendTuwenArk, false, '0xdc2_34 在名单但抓包不带 tag 24（显式覆盖）'],
];

/** `[spec 名, spec, 期望最终 needSign, 期望来源]` —— 走 raw SSO 命令串的服务。 */
const TRPC_CASES: [string, { cmd: string; needSign?: boolean }, boolean, string][] = [
  ['GetGroupHistory', GetGroupHistory, false, 'SsoGetGroupMsg 不在白名单'],
  ['GetC2cHistory', GetC2cHistory, false, 'SsoGetC2cMsg 不在白名单'],
  ['GetAlbumMediaList', GetAlbumMediaList, false, 'QunMedia.GetMediaList 不在白名单'],
  ['SendLocationArk', SendLocationArk, false, 'LocationArk.SsoSendMessage 不在白名单'],
  ['SetOnlineStatus', SetOnlineStatus, false, 'StatusService.SetStatus 不在白名单'],
  ['SetDiyOnlineStatus', SetDiyOnlineStatus, false, 'StatusService.SetStatus 不在白名单'],
  ['ReadedReport', ReadedReport, true, 'SsoReadedReport 在白名单'],
  ['DeleteGroupAlbumMedia', DeleteGroupAlbumMedia, false, 'QunMedia.DeleteMedias 不在白名单'],
  ['SetGroupAlbumLike', SetGroupAlbumLike, false, 'FeedsWriter.DoQunLike 不在白名单'],
  [
    'GetGroupAlbumFeedDetail',
    GetGroupAlbumFeedDetail,
    false,
    'FeedsReader.GetQunFeedDetail 不在白名单',
  ],
  ['CommentGroupAlbumMedia', CommentGroupAlbumMedia, false, 'FeedsWriter.DoQunComment 不在白名单'],
  ['FetchCustomFaceList', FetchCustomFaceList, false, 'Faceroam.OpReq 不在白名单'],
  ['DeleteCustomFace', DeleteCustomFace, false, 'Faceroam.OpReq 不在白名单'],
];

describe('签名白名单推导', () => {
  it('oidbWireCommand 与 native 的发包格式一致（小写十六进制）', () => {
    expect(oidbWireCommand(0x89a, 15)).toBe('OidbSvcTrpcTcp.0x89a_15');
    expect(oidbWireCommand(0x6d6, 3)).toBe('OidbSvcTrpcTcp.0x6d6_3');
    expect(oidbWireCommand(0xeb7, 1)).toBe('OidbSvcTrpcTcp.0xeb7_1');
  });

  it('名单命中/未命中', () => {
    expect(oidbNeedsSign(0x89a, 15)).toBe(true);
    expect(oidbNeedsSign(0x6d6, 2)).toBe(true);
    expect(oidbNeedsSign(0x6d6, 0)).toBe(false);
    expect(oidbNeedsSign(0x6d7, 0)).toBe(false);
    expect(commandNeedsSign('trpc.msg.msg_svc.MsgService.SsoReadedReport')).toBe(true);
    expect(commandNeedsSign('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg')).toBe(false);
  });

  it('大小写不敏感（Lagrange 名单里有 OidbSvcTRPCTcp 这类历史拼写）', () => {
    expect(commandNeedsSign('OidbSvcTRPCTcp.0x758_1')).toBe(true);
    expect(commandNeedsSign('oidbsvctrpctcp.0x758_1')).toBe(true);
  });

  for (const [name, spec, expected, reason] of OIDB_CASES) {
    it(`${name}：生效 needSign === ${expected}（${reason}）`, () => {
      const effective = spec.needSign ?? oidbNeedsSign(spec.command, spec.subCommand ?? 0);
      expect(effective).toBe(expected);
    });
  }

  for (const [name, spec, expected, reason] of TRPC_CASES) {
    it(`${name}：生效 needSign === ${expected}（${reason}）`, () => {
      const effective = spec.needSign ?? commandNeedsSign(spec.cmd);
      expect(effective).toBe(expected);
    });
  }
});
