/**
 * ChatImageOcrService 的离线单测 —— 整条链路都在本地打桩，不连网络：
 *
 *   1. 私聊 / 群聊分别要 type 10 / 20 的下载 rkey（OIDB 0x9067_202）；
 *   2. 用 fileToken 拼出的 CDN 直链 appid 对应 1406 / 1407；
 *   3. 0xe07_0 的 inner body 断言（URL、宽高、md5 小写）；md5 缺省时不带上；
 *   4. 回包映射成 blocks + 尺寸；rkey 拿不到 / 缺 fileToken 时如实抛错。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode, FetchDownloadRkeys, OcrImage } from '@weq/protocol';
import type { AccountSession } from '@weq/account';
import { ChatImageOcrService } from '../src/account/ocr_image';

const PID = 4321;
const TOKEN = 'EhRlK1ZaR8nnN1j9Molx05YqMGIX4RiOogcg_goo0';

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
}

/** 按命令字回不同内容的记账 native：0x9067_202 给 rkey，0xe07_0 给 OCR 回包。 */
function fakeNative(reply: { rkeyType?: number; ocrStatus?: string; rkey?: string }) {
  const calls: OidbCall[] = [];
  return {
    calls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
    ): Promise<Buffer> => {
      calls.push({ pid, command, subCommand, body: new Uint8Array(body), isUid });
      if (command === 0x9067) {
        const rkey = reply.rkey ?? '&rkey=TESTRKEY';
        const bytes = reply.rkeyType
          ? encode(FetchDownloadRkeys.respSchema, {
              downloadRkey: {
                rkeys: [
                  {
                    rkey,
                    rkeyTtlSec: 3600,
                    type: reply.rkeyType,
                    rkeyCreateTime: 1_792_000_000,
                  },
                ],
              },
            })
          : new Uint8Array(0);
        return Buffer.from(bytes);
      }
      const bytes = encode(OcrImage.respSchema, {
        status: reply.ocrStatus ?? 'succ',
        result: {
          srcLang: 'zh',
          sessionId: 'session-1',
          imageWidth: 1305,
          imageHeight: 2321,
          blocks: [
            {
              text: '扫一扫二维码，加入群聊',
              field2: 100,
              parag: '{"Parag":{"ParagNo":3}}',
              quad: { points: [{ x: 414, y: 2025 }] },
              bbox: { x: 414, y: 2025, width: 472, height: 47 },
            },
          ],
        },
      });
      return Buffer.from(bytes);
    },
  };
}

const session = {} as unknown as AccountSession;
const params = { fileToken: TOKEN, width: 1305, height: 2321 };

describe('ChatImageOcrService', () => {
  it('私聊：要 type 10 的 rkey，直链用 appid 1406', async () => {
    const nt = fakeNative({ rkeyType: 10 });
    const service = new ChatImageOcrService(nt, session, () => PID);

    const result = await service.recognize({ ...params, peerType: 'c2c' });

    expect(nt.calls).toHaveLength(2);
    const [rkeyCall, ocrCall] = nt.calls;
    expect(rkeyCall!.command).toBe(0x9067);
    expect(rkeyCall!.subCommand).toBe(202);
    expect(rkeyCall!.isUid).toBe(true);

    expect(ocrCall!.command).toBe(0xe07);
    expect(ocrCall!.subCommand).toBe(0);
    const body = decode(OcrImage.reqSchema, ocrCall!.body) as {
      image: { url: string; width: number; height: number; fileMd5: string };
    };
    expect(body.image.url).toBe(
      `https://multimedia.nt.qq.com.cn/download?appid=1406&fileid=${encodeURIComponent(TOKEN)}` +
        '&spec=0&rkey=TESTRKEY',
    );
    expect(body.image.width).toBe(1305);
    expect(body.image.height).toBe(2321);
    // 没给 md5 就不带上（服务端按 URL 取图，不看它）。
    expect(body.image.fileMd5).toBeUndefined();

    expect(result.status).toBe('succ');
    expect(result.imageWidth).toBe(1305);
    expect(result.imageHeight).toBe(2321);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.text).toBe('扫一扫二维码，加入群聊');
    expect(result.blocks[0]!.rect).toEqual({ x: 414, y: 2025, width: 472, height: 47 });
  });

  it('群聊：要 type 20 的 rkey，直链用 appid 1407，md5 统一小写', async () => {
    const nt = fakeNative({ rkeyType: 20 });
    const service = new ChatImageOcrService(nt, session, () => PID);

    await service.recognize({
      ...params,
      peerType: 'group',
      md5: 'F0628194E073D6C64E912B58F2CCBA7F',
      fileSize: 123229,
    });

    const ocrCall = nt.calls[1]!;
    const body = decode(OcrImage.reqSchema, ocrCall.body) as {
      image: { url: string; fileMd5: string; fileSize: number };
    };
    expect(body.image.url).toContain('appid=1407');
    expect(body.image.fileMd5).toBe('f0628194e073d6c64e912b58f2ccba7f');
    expect(body.image.fileSize).toBe(123229);
  });

  it('rkey 拿不到时如实抛错（不发 OCR 那一包）', async () => {
    const nt = fakeNative({ rkeyType: 0 });
    const service = new ChatImageOcrService(nt, session, () => PID);

    await expect(service.recognize({ ...params, peerType: 'c2c' })).rejects.toThrow(/rkey/);
    expect(nt.calls).toHaveLength(1);
  });

  it('服务端回非 succ 时抛错，带上状态串', async () => {
    const nt = fakeNative({ rkeyType: 10, ocrStatus: 'failed' });
    const service = new ChatImageOcrService(nt, session, () => PID);

    await expect(service.recognize({ ...params, peerType: 'c2c' })).rejects.toThrow(/failed/);
  });

  it('缺 fileToken / 缺尺寸 / QQ 未在线都不发包', async () => {
    const nt = fakeNative({ rkeyType: 10 });
    const service = new ChatImageOcrService(nt, session, () => PID);
    await expect(service.recognize({ ...params, peerType: 'c2c', fileToken: '' })).rejects.toThrow(
      /fileToken/,
    );
    await expect(service.recognize({ ...params, peerType: 'c2c', width: 0 })).rejects.toThrow(
      /尺寸/,
    );

    const offline = new ChatImageOcrService(nt, session, () => 0);
    await expect(offline.recognize({ ...params, peerType: 'c2c' })).rejects.toThrow(/未在线/);
    expect(nt.calls).toHaveLength(0);
  });
});
