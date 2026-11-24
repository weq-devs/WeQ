import { describe, expect, it } from 'vitest';
import { groupPermission, qqResourceOwnedBy, recallPermission } from '../src/common/qq_permissions';

describe('按操作区分 QQ 权限', () => {
  it('撤回和群昵称不共用同级管理员规则', () => {
    expect(groupPermission('recall', { role: 'admin', targetRole: 'admin' })).toBe(false);
    expect(groupPermission('recall', { role: 'admin', targetRole: 'owner' })).toBe(false);
    expect(groupPermission('recall', { role: 'admin', targetRole: 'member' })).toBe(true);
    expect(groupPermission('card', { role: 'admin', targetRole: 'admin' })).toBe(true);
    expect(groupPermission('card', { role: 'admin', targetRole: 'owner' })).toBe(false);
  });
  it('普通成员获准踢人不等于获得禁言或黑名单权限', () => {
    const state = { role: 'member' as const, targetRole: 'member' as const, allowMemberKick: true };
    expect(groupPermission('kick', state)).toBe(true);
    expect(groupPermission('mute', state)).toBe(false);
    expect(groupPermission('kickReject', state)).toBe(false);
    expect(groupPermission('kick', { ...state, targetRole: 'admin' })).toBe(false);
    expect(groupPermission('kick', { ...state, isSelf: true })).toBe(false);
    expect(groupPermission('kick', { role: 'owner', targetRole: null })).toBe(false);
    expect(groupPermission('kick', { role: 'owner', targetRole: 'owner' })).toBe(false);
    expect(groupPermission('kick', { role: 'owner', targetRole: 'admin' })).toBe(true);
  });
  it('临时管理只参与撤回且尊重明确的撤回拒绝', () => {
    const state = { role: 'member' as const, targetRole: 'member' as const, temporaryRecall: true };
    expect(groupPermission('recall', state)).toBe(true);
    expect(groupPermission('mute', state)).toBe(false);
    expect(groupPermission('recall', { ...state, recallAllowed: false })).toBe(false);
    expect(groupPermission('recall', { role: 'admin', targetRole: undefined })).toBe(false);
  });
  it('群名和精华根据各自开关开放，逐条能力覆盖角色', () => {
    expect(groupPermission('name', { role: 'member', memberCanRename: true })).toBe(true);
    expect(groupPermission('essenceSet', { role: 'member', memberCanEssence: true })).toBe(true);
    expect(groupPermission('essenceRemove', { role: 'member', isSelf: true })).toBe(true);
    expect(groupPermission('essenceRemove', { role: 'admin', canRemove: false })).toBe(false);
    expect(groupPermission('essenceRemove', { role: 'member', canRemove: true })).toBe(true);
  });
  it('上传者可以改名删除，但不能移动或管理文件夹', () => {
    const state = { role: 'member' as const, owned: true };
    expect(groupPermission('fileDelete', state)).toBe(true);
    expect(groupPermission('fileRename', state)).toBe(true);
    expect(groupPermission('fileMove', state)).toBe(false);
    expect(groupPermission('folder', state)).toBe(false);
    expect(groupPermission('folder', { role: 'admin' })).toBe(true);
  });
  it('禁言到期按当前时间恢复，管理者只豁免全员禁言', () => {
    expect(groupPermission('speak', { role: 'member', muteAll: true })).toBe(false);
    expect(groupPermission('speak', { role: 'admin', muteAll: true })).toBe(true);
    expect(groupPermission('speak', { role: 'admin', muteUntil: 200, now: 100 })).toBe(false);
    expect(groupPermission('speak', { role: 'member', muteUntil: 100, now: 100 })).toBe(true);
  });
});

describe('QQ 资源归属', () => {
  it.each(['u_self', '12345'])('可信的本人标识 %s 均可命中', (owner) => {
    expect(qqResourceOwnedBy(owner, { uid: 'u_self', uin: '12345' })).toBe(true);
  });
  it.each(['', '0', '昵称', 'u_other', '99999'])('不靠空值或昵称匹配 %s', (owner) => {
    expect(qqResourceOwnedBy(owner, { uid: 'u_self', uin: '12345' })).toBe(false);
  });
});

describe('消息撤回时间与身份', () => {
  it('私聊文件两小时，不影响私聊文本和群文件', () => {
    const base = { mine: true, ageMs: 180_000 };
    expect(recallPermission({ ...base, kind: 'c2c', file: true }).reason).toBeNull();
    expect(recallPermission({ ...base, kind: 'c2c', plainText: true })).toMatchObject({
      reason: null,
      warning: expect.stringContaining('2 分钟'),
    });
    expect(
      recallPermission({ ...base, kind: 'group', file: true, role: 'member' }).reason,
    ).toContain('2 分钟');
    expect(
      recallPermission({ ...base, kind: 'c2c', file: true, ageMs: 7_200_001 }).reason,
    ).toContain('2 小时');
  });
  it('管理者不绕过目标身份检查，但本人不走代管权限', () => {
    expect(
      recallPermission({ kind: 'group', mine: false, role: 'admin', targetRole: 'admin' }).reason,
    ).not.toBeNull();
    expect(
      recallPermission({ kind: 'group', mine: true, role: 'admin', ageMs: 180_000 }).reason,
    ).toBeNull();
    expect(
      recallPermission({
        kind: 'group',
        mine: false,
        role: 'owner',
        targetRole: 'admin',
        ageMs: 180_000,
      }).reason,
    ).toBeNull();
  });
});

it('管理员的明确逐项限制不会覆盖群主或普通成员的角色规则', () => {
  expect(
    groupPermission('kick', { role: 'admin', targetRole: 'member', adminKickAllowed: false }),
  ).toBe(false);
  expect(
    groupPermission('kickReject', { role: 'admin', targetRole: 'member', adminKickAllowed: false }),
  ).toBe(false);
  expect(
    groupPermission('kick', { role: 'owner', targetRole: 'member', adminKickAllowed: false }),
  ).toBe(true);
  expect(
    groupPermission('kick', { role: 'admin', targetRole: 'member', adminKickAllowed: null }),
  ).toBe(true);
  expect(
    groupPermission('recall', { role: 'admin', targetRole: 'member', recallAllowed: false }),
  ).toBe(false);
});
