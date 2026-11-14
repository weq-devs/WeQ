import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { GroupInfoService } from '../src/account/group_info';

function fixture() {
  const directory = vi.fn(async () => [{ groupCode: '123', role: 'admin' }]);
  const getMember = vi.fn(async () => ({ adminFlag: 1, memberFlag: 0 }));
  const messages = vi.fn(async () => [{ senderUid: 'u_peer', senderUin: 20002n }]);
  const session = {
    context: { uin: '10001' },
    selfUid: 'u_self',
    groupDetail: { listDirectory: directory, getDetail: async () => ({ ownerUid: 'u_owner' }) },
    groupMembers: { getMember },
    groupMsgs: { listBySeqsInPartition: messages },
  } as unknown as AccountSession;
  return { service: new GroupInfoService(session), session, directory, getMember, messages };
}

describe('群操作提交前以真实目标重新核对', () => {
  it('管理员不能撤回同级；修改同级昵称则允许', async () => {
    const f = fixture();
    await expect(f.service.assertOperation('recall', 123, undefined, 42)).rejects.toThrow('无权');
    await expect(f.service.assertOperation('card', 123, 'u_peer')).resolves.toBeUndefined();
    expect(f.messages).toHaveBeenCalledWith('123', [42n]);
  });
  it('角色变化后下一次操作不沿用旧许可', async () => {
    const f = fixture();
    f.getMember.mockResolvedValue({ adminFlag: 0, memberFlag: 0 });
    await expect(f.service.assertOperation('mute', 123, 'u_peer')).resolves.toBeUndefined();
    f.directory.mockResolvedValue([{ groupCode: '123', role: 'member' }]);
    await expect(f.service.assertOperation('mute', 123, 'u_peer')).rejects.toThrow('无权');
  });
  it('本人消息不套用代管撤回的目标角色规则', async () => {
    const f = fixture();
    f.messages.mockResolvedValue([{ senderUid: 'u_self', senderUin: 10001n }]);
    await expect(f.service.assertOperation('recall', 123, undefined, 42)).resolves.toBeUndefined();
  });
  it('已离群目标不继续按普通成员允许管理操作', async () => {
    const f = fixture();
    f.getMember.mockResolvedValue({ adminFlag: 0, memberFlag: 1 });
    await expect(f.service.assertOperation('mute', 123, 'u_peer')).rejects.toThrow('无权');
  });
  it('没有精华 Web 返回时不覆盖本地已确认的消息作者', async () => {
    const f = fixture();
    f.directory.mockResolvedValue([{ groupCode: '123', role: 'member' }]);
    f.messages.mockResolvedValue([{ senderUid: 'u_self', senderUin: 10001n }]);
    await expect(
      f.service.assertOperation('essenceRemove', 123, undefined, 42),
    ).resolves.toBeUndefined();
  });
  it('精华短页不表示已经读完，使用明确的 complete 继续寻找逐条权限', async () => {
    const f = fixture();
    const getGroupEssencePage = vi
      .fn()
      .mockResolvedValueOnce({ messages: [{ msg_seq: 1, can_be_removed: false }], complete: false })
      .mockResolvedValueOnce({
        messages: [{ msg_seq: 42, can_be_removed: true, sender_uin: '10001' }],
        complete: true,
      });
    f.service.setWebQueryService({ getGroupEssence: vi.fn(), getGroupEssencePage });
    await expect(f.service.essenceOperationPermission(123, 42)).resolves.toEqual({
      canRemove: true,
      isSelf: true,
    });
    expect(getGroupEssencePage).toHaveBeenCalledTimes(2);
  });
  it('QQ 离线时仍可读取本地权限，不尝试发包', async () => {
    const f = fixture();
    const sendOidbPacket = vi.fn();
    const service = new GroupInfoService(f.session, {
      nt: { sendOidbPacket },
      resolvePid: () => {
        throw new Error('QQ 未在线');
      },
    });
    await expect(service.operationContext(123)).resolves.toMatchObject({ role: 'admin' });
    expect(sendOidbPacket).not.toHaveBeenCalled();
  });
  it('群发文件的一次新读取同时检查发言与上传，而不是复用展示缓存', async () => {
    const f = fixture();
    const context = vi
      .spyOn(f.service, 'operationContext')
      .mockResolvedValue({ role: 'member', memberCanUpload: false });
    await expect(f.service.assertCanSend(123, true)).rejects.toThrow('上传');
    expect(context).toHaveBeenCalledOnce();
    expect(context).toHaveBeenCalledWith(123, undefined, true);
    context.mockResolvedValue({ role: 'admin', muteUntil: Date.now() / 1000 + 60 });
    await expect(f.service.assertCanSend(123, false)).rejects.toThrow('禁言');
  });
  it('读取期间同号切换来源，不接受迟到的权限', async () => {
    const f = fixture();
    let active = true;
    f.service.setOperationGuard(() => {
      if (!active) throw new Error('来源已切换');
    });
    f.directory.mockImplementation(async () => {
      active = false;
      return [{ groupCode: '123', role: 'owner' }];
    });
    await expect(f.service.assertOperation('mute', 123, 'u_peer')).rejects.toThrow('来源已切换');
  });
});
