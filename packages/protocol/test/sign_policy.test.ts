import { describe, expect, it } from 'vitest';
import {
  DeleteGroupFile,
  FetchCustomFaceDetail,
  FetchFilteredGroupRequests,
  FetchGroupRequests,
  GetFriendSnsPage,
  GetGroupFileUrl,
  GetGroupMessagePolicies,
  GetGroupPttUrl,
  GetGroupVideoUrl,
  GetPrivateFileUrl,
  GetPrivatePttUrl,
  GetPrivateVideoUrl,
  GetUserOnlineStatus,
  GetUserQqLevel,
  ModifyCustomFace,
  MoveCustomFace,
  needSignFor,
  SetGroupMemberCard,
  SetGroupMessagePolicy,
  SetReaction,
  SIGN_NON_LINUX,
} from '../src/index';

describe('needSignFor', () => {
  it('boolean 三端一致', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(needSignFor(true, platform)).toBe(true);
      expect(needSignFor(false, platform)).toBe(false);
    }
  });

  it('平台对象逐端取值，不再互相回落', () => {
    expect(needSignFor({ linux: true, win32: false, darwin: false }, 'linux')).toBe(true);
    expect(needSignFor({ linux: true, win32: false, darwin: false }, 'win32')).toBe(false);
    expect(needSignFor({ linux: true, win32: false, darwin: false }, 'darwin')).toBe(false);

    expect(needSignFor({ linux: true, win32: false, darwin: true }, 'darwin')).toBe(true);
  });

  it('SIGN_NON_LINUX：Linux 不签，Windows / macOS 签', () => {
    expect(needSignFor(SIGN_NON_LINUX, 'linux')).toBe(false);
    expect(needSignFor(SIGN_NON_LINUX, 'win32')).toBe(true);
    expect(needSignFor(SIGN_NON_LINUX, 'darwin')).toBe(true);
  });
});

/** issue #126 里 Linux 与 Windows 结论不一致的公开 spec。 */
const NON_LINUX_SIGNED_SPECS = [
  ['FetchGroupRequests', FetchGroupRequests.needSign],
  ['FetchFilteredGroupRequests', FetchFilteredGroupRequests.needSign],
  ['SetGroupMemberCard', SetGroupMemberCard.needSign],
  ['DeleteGroupFile', DeleteGroupFile.needSign],
  ['GetGroupFileUrl', GetGroupFileUrl.needSign],
  ['GetPrivateFileUrl', GetPrivateFileUrl.needSign],
  ['GetGroupPttUrl', GetGroupPttUrl.needSign],
  ['GetPrivatePttUrl', GetPrivatePttUrl.needSign],
  ['GetGroupVideoUrl', GetGroupVideoUrl.needSign],
  ['GetPrivateVideoUrl', GetPrivateVideoUrl.needSign],
  ['GetFriendSnsPage', GetFriendSnsPage.needSign],
  ['GetGroupMessagePolicies', GetGroupMessagePolicies.needSign],
  ['SetGroupMessagePolicy', SetGroupMessagePolicy.needSign],
  ['GetUserQqLevel', GetUserQqLevel.needSign],
  ['GetUserOnlineStatus', GetUserOnlineStatus.needSign],
  ['FetchCustomFaceDetail', FetchCustomFaceDetail.needSign],
  ['ModifyCustomFace', ModifyCustomFace.needSign],
  ['MoveCustomFace', MoveCustomFace.needSign],
] as const;

describe.each(NON_LINUX_SIGNED_SPECS)('%s 的跨平台签名声明', (_name, policy) => {
  it('Linux 不签，Windows / macOS 签', () => {
    expect(needSignFor(policy, 'linux')).toBe(false);
    expect(needSignFor(policy, 'win32')).toBe(true);
    expect(needSignFor(policy, 'darwin')).toBe(true);
  });
});

describe('macOS 实测与 Windows 不一致的命令', () => {
  it('0x9082 SetReaction：Linux / Windows 签，macOS 不签', () => {
    expect(needSignFor(SetReaction.needSign, 'linux')).toBe(true);
    expect(needSignFor(SetReaction.needSign, 'win32')).toBe(true);
    expect(needSignFor(SetReaction.needSign, 'darwin')).toBe(false);
  });
});
