import { describe, expect, it, vi } from 'vitest';
import { GroupMemberNotifyService } from '../src/account/group_member_notify';
import { encode, message, type TrpcNative } from '@weq/protocol';

const card = message([
  { name: 'group', tag: 1, type: 'uint64' },
  {
    name: 'member',
    tag: 3,
    type: message([
      { name: 'uin', tag: 1, type: 'uint64' },
      { name: 'result', tag: 2, type: 'uint32', force: true },
      { name: 'mode', tag: 30, type: 'uint32', force: true },
    ]),
  },
]);
function fixture() {
  let pid = 1;
  let mode: number | undefined = 0;
  const member = vi.fn(async (groupCode: bigint, uid: string) => ({ groupCode, uid, uin: 456n }));
  const send = vi.fn<TrpcNative['sendPacket']>(async (_pid, cmd) =>
    cmd === 'group_member_card.get_group_member_card_info'
      ? Buffer.from(encode(card, { group: 123n, member: { uin: 456n, result: 0, mode } }))
      : Buffer.from('08bb1110021800', 'hex'),
  );
  const service = new GroupMemberNotifyService({ sendPacket: send }, () => pid, member);
  return {
    service,
    send,
    member,
    switchPid: () => pid++,
    mode: (value: number | undefined) => {
      mode = value;
    },
  };
}
describe('群成员提醒服务', () => {
  it('并发保存同一目标不重复提交，其他群不共用在途标记', async () => {
    const f = fixture();
    let release!: () => void;
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementationOnce(async (...args) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return original(...args);
    });
    const first = f.service.set(123, 'u_peer', 'concerned');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(f.service.set(123, 'u_peer', 'shielded')).rejects.toThrow('正在保存');
    await expect(f.service.read(124, 'u_peer')).rejects.toThrow('目标');
    release();
    expect(await first).toEqual({ state: 'accepted' });
    expect(f.send.mock.calls.filter((call) => call[1].startsWith('OidbSvc.'))).toHaveLength(1);
  });
  it('普通成员和非好友可独立写入，不访问好友特别关心；同值不写', async () => {
    const f = fixture();
    expect(await f.service.set(123, 'u_peer', 'default')).toEqual({ state: 'unchanged' });
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(await f.service.set(123, 'u_peer', 'concerned')).toEqual({ state: 'accepted' });
    expect(f.send.mock.calls.map((c) => c[1])).toEqual([
      'group_member_card.get_group_member_card_info',
      'group_member_card.get_group_member_card_info',
      'OidbSvc.0x8bb_2',
    ]);
  });
  it.each([undefined, 99])('未取得完整三态 %s 时不覆盖', async (value) => {
    const f = fixture();
    f.mode(value);
    await expect(f.service.set(123, 'u_peer', 'concerned')).rejects.toThrow('尚未取得');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('写超时保留待确认，随后独立读回而不重发', async () => {
    const f = fixture();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (...args) => {
      if (args[1].startsWith('OidbSvc.')) {
        f.mode(1);
        throw new Error('timeout');
      }
      return original(...args);
    });
    expect(await f.service.set(123, 'u_peer', 'concerned')).toEqual({ state: 'unconfirmed' });
    expect(await f.service.read(123, 'u_peer')).toMatchObject({ mode: 'concerned' });
    expect(f.send.mock.calls.filter((c) => c[1].startsWith('OidbSvc.'))).toHaveLength(1);
  });
  it('业务拒绝不当作已受理', async () => {
    const f = fixture();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (...args) =>
      args[1].startsWith('OidbSvc.') ? Buffer.from('08bb1110021841', 'hex') : original(...args),
    );
    await expect(f.service.set(123, 'u_peer', 'concerned')).rejects.toThrow('65');
  });
  it('目标解析及读取期间切号均停止后续写入', async () => {
    const f = fixture();
    f.member.mockImplementationOnce(async (groupCode, uid) => {
      f.switchPid();
      return { groupCode, uid, uin: 456n };
    });
    await expect(f.service.set(123, 'u_peer', 'concerned')).rejects.toThrow('切换');
    expect(f.send).not.toHaveBeenCalled();
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      f.switchPid();
      return result;
    });
    await expect(f.service.set(123, 'u_peer', 'concerned')).rejects.toThrow('切换');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('跨群或错成员记录不发包，同一成员在另一群仍独立读取', async () => {
    const f = fixture();
    f.member.mockResolvedValueOnce({ groupCode: 456n, uid: 'u_peer', uin: 456n });
    await expect(f.service.read(123, 'u_peer')).rejects.toThrow('目标');
    f.member.mockResolvedValueOnce({ groupCode: 123n, uid: 'u_other', uin: 456n });
    await expect(f.service.read(123, 'u_peer')).rejects.toThrow('目标');
    expect(f.send).not.toHaveBeenCalled();
    await expect(f.service.read(124, 'u_peer')).rejects.toThrow('目标');
    expect(f.member).toHaveBeenLastCalledWith(124n, 'u_peer');
  });
});
