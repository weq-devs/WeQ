import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSign } from '../src/sign-policy';
import { sendOidb, sendPacket } from '../src/transport';

afterEach(() => vi.restoreAllMocks());

describe('协议传输', () => {
  it('OIDB 的签名参数来自中央表（0xfd4_1 = Linux 不签 / 非 Linux 签）', async () => {
    const sendOidbPacket = vi.fn().mockResolvedValue(Buffer.from([3, 4]));
    const body = Uint8Array.from([1, 2]);

    const reply = await sendOidb({ sendOidbPacket }, 123, { command: 0xfd4, subCommand: 1, body });

    const expected = resolveSign('OidbSvcTrpcTcp.0xfd4_1');
    expect(sendOidbPacket).toHaveBeenCalledWith(
      123,
      0xfd4,
      1,
      Buffer.from(body),
      false,
      expected.needSign,
      expected.mode,
    );
    expect(reply).toEqual(Uint8Array.from([3, 4]));
  });

  it('原始 SSO 的签名参数来自中央表（含 mode=2 的命令）', async () => {
    const nativeSend = vi.fn().mockResolvedValue(Buffer.from([3, 4]));
    const body = Uint8Array.from([1, 2]);
    const cmd = 'trpc.msg.msg_svc.MsgService.SsoReadedReport';

    await sendPacket({ sendPacket: nativeSend }, 123, cmd, body);

    expect(nativeSend).toHaveBeenCalledWith(
      123,
      cmd,
      Buffer.from(body),
      true,
      process.platform === 'linux' ? 3 : 2,
    );
  });

  it('未登记的命令按不签名 / mode 3 发送', async () => {
    const nativeSend = vi.fn().mockResolvedValue(Buffer.from([0]));
    await sendPacket({ sendPacket: nativeSend }, 1, 'test.unregistered', Uint8Array.from([1]));
    expect(nativeSend).toHaveBeenCalledWith(1, 'test.unregistered', Buffer.alloc(1, 1), false, 3);
  });

  it.each([
    [0x9474, 0],
    [0xfe1, 3],
    [0x9067, 202],
  ])('已登记的不签名 OIDB %i_%i 保持原发包参数且不报警', async (command, subCommand) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const sendOidbPacket = vi.fn().mockResolvedValue(Buffer.from([0]));
    const body = Uint8Array.from([1]);

    await sendOidb({ sendOidbPacket }, 123, { command, subCommand, body });

    expect(sendOidbPacket).toHaveBeenCalledWith(
      123,
      command,
      subCommand,
      Buffer.from(body),
      false,
      false,
      3,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('override 可以强制覆盖（调试脚本用）', async () => {
    const nativeSend = vi.fn().mockResolvedValue(Buffer.from([0]));
    await sendPacket({ sendPacket: nativeSend }, 1, 'MessageSvc.PbSendMsg', Uint8Array.from([1]), {
      needSign: false,
    });
    // 只覆盖 needSign，mode 仍走表（这条命令 mode2）。
    expect(nativeSend).toHaveBeenCalledWith(
      1,
      'MessageSvc.PbSendMsg',
      Buffer.alloc(1, 1),
      false,
      process.platform === 'linux' ? 3 : 2,
    );
  });

  it('OIDB 发送异常继续向调用方抛出', async () => {
    const error = new Error('OIDB send failed');
    const sendOidbPacket = vi.fn().mockRejectedValue(error);
    await expect(
      sendOidb({ sendOidbPacket }, 123, { command: 0xfd4, subCommand: 1, body: new Uint8Array() }),
    ).rejects.toBe(error);
  });

  it('原始 SSO 发送异常继续向调用方抛出', async () => {
    const error = new Error('SSO send failed');
    const nativeSend = vi.fn().mockRejectedValue(error);
    await expect(
      sendPacket({ sendPacket: nativeSend }, 123, 'test.command', new Uint8Array()),
    ).rejects.toBe(error);
  });
});
