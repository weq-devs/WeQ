import { describe, expect, it, vi } from 'vitest';
import { decode, encode, GetGroupIdentity, SetGroupIdentity } from '@weq/protocol';
import { AccountWriteService } from '../src/account/account_write';

function fixture() {
  let pid = 5;
  let body: Record<string, unknown> = {
    userInfo: { uin: 10001n },
    level: { curLevel: 27, name: '等级名称' },
    titles: [
      { titleId: '0', name: '服务端等级头衔', isSet: true },
      { titleId: '7', name: '服务端专属头衔', isSet: false },
    ],
  };
  const send = vi.fn(
    async (
      _pid: number,
      command: number,
      _sub: number,
      _bytes: Buffer,
      _isUid?: boolean,
      _sign?: boolean,
    ) => {
      if (command === GetGroupIdentity.command)
        return Buffer.from(encode(GetGroupIdentity.respSchema, body));
      if (command === SetGroupIdentity.command) return Buffer.alloc(0);
      throw new Error('意外命令');
    },
  );
  const service = new AccountWriteService(
    { sendOidbPacket: send, sendPacket: async () => Buffer.alloc(0) },
    { uin: '10001', selfUid: 'u_self', getBuddy: async () => null, listCategories: async () => [] },
    () => pid,
  );
  return {
    service,
    send,
    switchPid: () => {
      pid = 6;
    },
    setBody: (value: Record<string, unknown>) => {
      body = value;
    },
  };
}

describe('当前账号群头衔选择', () => {
  it('查询使用账号自己的UIN，并保留独立等级及明确选中状态', async () => {
    const f = fixture();
    const result = await f.service.getGroupIdentity(123);
    expect(result).toMatchObject({
      groupId: 123,
      memberUin: '10001',
      selectedTitleId: '0',
      level: { value: 27, name: '等级名称' },
    });
    const call = f.send.mock.calls[0]!;
    expect(decode(GetGroupIdentity.reqSchema, call[3])).toEqual({
      groupId: 123n,
      memberUin: 10001n,
    });
    expect(call[4]).toBe(true);
  });
  it('设置前重新读取目录，允许重复提交当前选择，不能把受理当成读回一致', async () => {
    const f = fixture();
    expect(await f.service.groupIdentity(123, 0)).toEqual({ state: 'accepted' });
    expect(f.send.mock.calls.map((call) => call[1])).toEqual([
      GetGroupIdentity.command,
      SetGroupIdentity.command,
    ]);
    const call = f.send.mock.calls[1]!;
    expect(decode(SetGroupIdentity.reqSchema, call[3])).toEqual({ groupId: 123n, titleId: 0 });
    expect(call[4]).toBe(true);
  });
  it('不允许提交未出现在当前目录中的猜测ID', async () => {
    const f = fixture();
    await expect(f.service.groupIdentity(123, 99)).rejects.toThrow('可选');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('AppID规则拒绝时原样抛出，不尝试其他通道或盲发设置', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('OIDB error 319: rule type not match appid'));
    await expect(f.service.groupIdentity(123, 7)).rejects.toThrow('rule type not match appid');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('目录返回其他成员时不修改当前账号选择', async () => {
    const f = fixture();
    f.setBody({ userInfo: { uin: 10002n }, titles: [{ titleId: '7', name: '头衔' }] });
    await expect(f.service.groupIdentity(123, 7)).rejects.toThrow('成员');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('目录读取过程中切换运行时，读结果和后续写入都失效', async () => {
    const f = fixture();
    f.send.mockImplementationOnce(async () => {
      f.switchPid();
      return Buffer.from(
        encode(GetGroupIdentity.respSchema, {
          userInfo: { uin: 10001n },
          titles: [{ titleId: '7', name: '头衔', isSet: true }],
        }),
      );
    });
    await expect(f.service.groupIdentity(123, 7)).rejects.toThrow('切换');
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});
