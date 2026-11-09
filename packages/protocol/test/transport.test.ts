import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendOidb, sendPacket } from '../src/transport';

afterEach(() => vi.restoreAllMocks());

describe('协议传输日志', () => {
  it.each([true, false])('OIDB 请求保留 needSign=%s，不输出签名前缀', async (needSign) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sendOidbPacket = vi.fn().mockResolvedValue(Buffer.from([3, 4]));
    const body = Uint8Array.from([1, 2]);

    const reply = await sendOidb(
      { sendOidbPacket },
      123,
      { command: 0xfd4, subCommand: 1, body },
      needSign,
    );

    expect(sendOidbPacket).toHaveBeenCalledTimes(1);
    expect(sendOidbPacket).toHaveBeenCalledWith(123, 0xfd4, 1, Buffer.from(body), false, needSign);
    expect(reply).toEqual(Uint8Array.from([3, 4]));
    expect(log).not.toHaveBeenCalled();
  });

  it.each([true, false])('原始 SSO 请求保留 needSign=%s，不输出签名前缀', async (needSign) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const nativeSend = vi.fn().mockResolvedValue(Buffer.from([3, 4]));
    const body = Uint8Array.from([1, 2]);
    const cmd = 'trpc.msg.msg_svc.MsgService.SsoReadedReport';

    const reply = await sendPacket({ sendPacket: nativeSend }, 123, cmd, body, needSign);

    expect(nativeSend).toHaveBeenCalledTimes(1);
    expect(nativeSend).toHaveBeenCalledWith(123, cmd, Buffer.from(body), needSign);
    expect(reply).toEqual(Uint8Array.from([3, 4]));
    expect(log).not.toHaveBeenCalled();
  });

  it('OIDB 发送异常继续向调用方抛出', async () => {
    const error = new Error('OIDB send failed');
    const sendOidbPacket = vi.fn().mockRejectedValue(error);
    await expect(
      sendOidb(
        { sendOidbPacket },
        123,
        { command: 0xfd4, subCommand: 1, body: new Uint8Array() },
        true,
      ),
    ).rejects.toBe(error);
  });

  it('原始 SSO 发送异常继续向调用方抛出', async () => {
    const error = new Error('SSO send failed');
    const nativeSend = vi.fn().mockRejectedValue(error);
    await expect(
      sendPacket({ sendPacket: nativeSend }, 123, 'test.command', new Uint8Array(), true),
    ).rejects.toBe(error);
  });
});
