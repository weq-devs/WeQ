import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { GroupInfoService } from '../src/account/group_info';

function fixture() {
  const directory = vi.fn(async () => [{ groupCode: '123', role: 'admin' }]);
  const getMember = vi.fn(async () => ({ adminFlag: 1, memberFlag: 0 }));
  const messages = vi.fn(
    async (): Promise<
      Array<{ senderUid: string; senderUin: bigint; msgType?: bigint; msgRandom?: bigint }>
    > => [{ senderUid: 'u_peer', senderUin: 20002n }],
  );
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
  it('撤回忽略同号灰条，并用回执 random 区分同号正文', async () => {
    const f = fixture();
    f.directory.mockResolvedValue([{ groupCode: '123', role: 'member' }]);
    const tip = { senderUid: 'u_tip', senderUin: 20003n, msgType: 5n, msgRandom: 99n };
    const own = { senderUid: 'u_self', senderUin: 10001n, msgType: 2n, msgRandom: 33n };
    f.messages.mockResolvedValueOnce([tip, own]);
    await expect(f.service.assertOperation('recall', 123, undefined, 42)).resolves.toBeUndefined();
    const peer = { ...own, senderUid: 'u_peer', senderUin: 20002n, msgRandom: 44n };
    f.messages.mockResolvedValue([tip, peer, own]);
    await expect(
      f.service.assertOperation('recall', 123, undefined, 42, 33),
    ).resolves.toBeUndefined();
    await expect(f.service.assertOperation('recall', 123, undefined, 42, 44)).rejects.toThrow(
      '无权',
    );
    await expect(f.service.assertOperation('recall', 123, undefined, 42)).rejects.toThrow('无权');
    f.messages.mockClear();
    f.directory.mockResolvedValue([{ groupCode: '123', role: 'admin' }]);
    await expect(
      f.service.assertOperation('essenceSet', 123, undefined, 42, 33),
    ).resolves.toBeUndefined();
    expect(f.messages).not.toHaveBeenCalled();
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
  it('群发文件由同一次权限核对同时检查发言与上传', async () => {
    const f = fixture();
    const context = vi
      .spyOn(f.service, 'operationContext')
      .mockResolvedValue({ role: 'member', memberCanUpload: false });
    await expect(f.service.assertCanSend(123, true)).rejects.toThrow('上传');
    expect(context).toHaveBeenCalledOnce();
    expect(context).toHaveBeenCalledWith(123);
    context.mockResolvedValue({ role: 'admin', muteUntil: Date.now() / 1000 + 60 });
    await expect(f.service.assertCanSend(123, false)).rejects.toThrow('禁言');
  });
  it('群发送定向读取群号，不因无关群详情失败被挡住', async () => {
    const f = fixture();
    const detail = vi
      .spyOn(f.service, 'getGroupDetail')
      .mockRejectedValue(new Error('群详情不可用'));
    await expect(f.service.assertCanSend(123, false)).resolves.toBeUndefined();
    expect(f.directory).toHaveBeenCalledWith(123n);
    expect(detail).not.toHaveBeenCalled();
  });
  it('实际权限查询回包能拦截全员禁言群的普通成员发送，管理者仍可发言', async () => {
    const f = fixture();
    f.directory.mockResolvedValue([{ groupCode: '123', role: 'member' }]);
    // 同群线上 0x88d_0 回包，群号脱敏为 123；保留独立于协议 schema 的字节。
    const sendOidbPacket = vi.fn(async () =>
      Buffer.from(
        '0a2a087b10001a2430f909e802c4b4e5d70ef00200c003c081a420f80400b00500c00500e00604ea06020804',
        'hex',
      ),
    );
    const service = new GroupInfoService(f.session, {
      nt: { sendOidbPacket },
      resolvePid: () => 9,
    });
    await expect(service.operationContext(123)).resolves.toMatchObject({
      role: 'member',
      muteAll: true,
      muteUntil: 0,
    });
    await expect(service.assertCanSend(123, false)).rejects.toThrow('禁言');
    f.directory.mockResolvedValue([{ groupCode: '123', role: 'admin' }]);
    await expect(service.assertCanSend(123, false)).resolves.toBeUndefined();
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
