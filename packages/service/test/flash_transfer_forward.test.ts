import { describe, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { FlashTransferService } from '../src/account/flash_transfer';
import { resolveSign } from '@weqbot/protocol';

const FILESET = 'fixture-fileset';
const session = {
  uidMap: { uidByUin: (uin: bigint) => (uin === 20002n ? 'u_friend' : undefined) },
} as unknown as AccountSession;

function fixture() {
  const sendOidbPacket = vi.fn(async () => Buffer.from('0a081a0608021a02087b', 'hex'));
  const nt = { sendOidbPacket };
  return { sendOidbPacket, service: new FlashTransferService(nt, session, () => 4321) };
}

describe('已有闪传文件集专用转发', () => {
  it.each(['20002', 'u_friend'])(
    '私聊 %s 只发送 0x93d7，不创建文件集或重传文件',
    async (targetId) => {
      const { service, sendOidbPacket } = fixture();
      const result = await service.forwardFlashTransfer({
        peerType: 'c2c',
        targetId,
        fileSetId: FILESET,
      });
      expect(result).toEqual({ ok: true, fileSetId: FILESET });
      // 独立黄金字节：target{type=1, c2c{uid}} + 原 fileSetId；不以生产 schema 自证。
      expect(sendOidbPacket.mock.calls).toEqual([
        [
          4321,
          0x93d7,
          1,
          Buffer.from('0a0e0801120a0a08755f667269656e64120f666978747572652d66696c65736574', 'hex'),
          false,
          true,
          resolveSign('OidbSvcTrpcTcp.0x93d7_1').mode,
        ],
      ]);
    },
  );

  it('群聊走群目标，保持原文件集身份', async () => {
    const { service, sendOidbPacket } = fixture();
    await service.forwardFlashTransfer({ peerType: 'group', targetId: '123', fileSetId: FILESET });
    expect(sendOidbPacket.mock.calls).toEqual([
      [
        4321,
        0x93d7,
        1,
        Buffer.from('0a0608021a02087b120f666978747572652d66696c65736574', 'hex'),
        false,
        true,
        resolveSign('OidbSvcTrpcTcp.0x93d7_1').mode,
      ],
    ]);
  });

  it.each([
    { peerType: 'c2c' as const, targetId: '30003', fileSetId: FILESET },
    { peerType: 'group' as const, targetId: 'invalid', fileSetId: FILESET },
    { peerType: 'group' as const, targetId: '123', fileSetId: ' ' },
    { peerType: 'c2c' as const, targetId: 'u_friend', fileSetId: FILESET, tempGroupCode: '123' },
    { peerType: 'c2c' as const, targetId: 'u_Wcc5rknRRqRO8y5gxMD6sA', fileSetId: FILESET },
  ])('无有效目标／身份时不发包：%j', async (params) => {
    const { service, sendOidbPacket } = fixture();
    await expect(service.forwardFlashTransfer(params)).rejects.toThrow();
    expect(sendOidbPacket).not.toHaveBeenCalled();
  });

  it('发包前重新检查账号，检查失败时不发送', async () => {
    const { service, sendOidbPacket } = fixture();
    await expect(
      service.forwardFlashTransfer({
        peerType: 'c2c',
        targetId: 'u_friend',
        fileSetId: FILESET,
        beforeSend: () => {
          throw new Error('账号已切换');
        },
      }),
    ).rejects.toThrow('账号已切换');
    expect(sendOidbPacket).not.toHaveBeenCalled();
  });

  it('服务端拒绝原样上抛，不回退普通 Markdown 造成重复请求', async () => {
    const { service, sendOidbPacket } = fixture();
    sendOidbPacket.mockRejectedValueOnce(new Error('fileset expired'));
    await expect(
      service.forwardFlashTransfer({ peerType: 'group', targetId: '123', fileSetId: FILESET }),
    ).rejects.toThrow('fileset expired');
    expect(sendOidbPacket).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['', /未返回目标发送状态/],
    ['0a00', /未返回发送目标/],
    ['0a0b0807120765787069726564', /7.*expired/],
  ])('OIDB 外层成功但内层失败／缺失时不假报成功：%s', async (hex, reason) => {
    const { service, sendOidbPacket } = fixture();
    sendOidbPacket.mockResolvedValueOnce(Buffer.from(hex, 'hex'));
    await expect(
      service.forwardFlashTransfer({
        peerType: 'group',
        targetId: '123',
        fileSetId: FILESET,
      }),
    ).rejects.toThrow(reason);
    expect(sendOidbPacket).toHaveBeenCalledTimes(1);
  });
});
