/**
 * FlashTransferService 的**发送时序回归**：封面必须在 0x93d7 发消息之前报备并上传完。
 *
 * 实机抓包（2026-10-10，含时间线）里 QQ 是「传完才发」：
 *
 *   0x93cf → 0x93d0 → 0x93db → 0x12a9（封面/主文件 prepare+apply+分片）→ 0x93d1
 *   →（约 25 秒后）0x93d7
 *
 * WeQ 曾经把 0x93d7 提到上传之前（「先发后传」）：对端一收到消息就拉 fileset，此时封面
 * 还没登记，卡片只显示默认封面，且客户端不会再重拉 —— 这条测试把它钉死，防止再回退。
 *
 * native 打桩：0x12a9 的 prepare 响应**不带 rkey**（秒传命中）⇒ 不传字节、不连网络，
 * 只记账真正上 wire 的 OIDB 顺序。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplyFileset, ApplyUpload, decode, encode, PrepareUpload } from '@weq/protocol';
import type { AccountSession } from '@weq/account';
import { FlashTransferService } from '../src/account/flash_transfer';

const PID = 4321;
const FILESET = '11111111-2222-3333-4444-555555555555';
/** apply 响应里服务端规范化的 filesetWrap 原始字节（sliceupload 原样回带的那个）。 */
const FILESET_REF = new Uint8Array([0x0a, 0x02, 0x01, 0x02]);

/** 最小合法 PNG：签名 + IHDR（256×256）。prepareThumbnail 只校验签名/IHDR/宽高。 */
function tinyPng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    Buffer.from([0x00, 0x00, 0x01, 0x00]), // width 256
    Buffer.from([0x00, 0x00, 0x01, 0x00]), // height 256
    Buffer.from([0x08, 0x06, 0x00, 0x00, 0x00]),
    Buffer.from([0, 0, 0, 0]), // crc（不校验）
  ]);
}

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
}

function fakeNative() {
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
      if (command === 0x93cf) {
        return Buffer.from(
          encode(ApplyFileset.respSchema, {
            filesetUuid: FILESET,
            uploadKey: FILESET,
            uploadUrl: 'https://qfile.qq.com/q/test',
          }),
        );
      }
      if (command === 0x12a9 && subCommand === 103) {
        return Buffer.from(
          encode(ApplyUpload.respSchema, { payload: { filesetWrap: FILESET_REF } }),
        );
      }
      // 其余（0x93d0/0x93db/0x93d7/0x93d1）空 ack；0x12a9_100 不带 rkey ⇒ 秒传命中，
      // 跳过 sliceupload，不需要网络。
      return Buffer.alloc(0);
    },
  };
}

function fakeSession(): AccountSession {
  return {
    context: { uin: 10001 },
    uidMap: {
      uidByUin: (uin: bigint) => (uin === 20002n ? 'u_friend' : undefined),
      uinByUid: (uid: string) => (uid === 'u_friend' ? 20002n : undefined),
    },
  } as unknown as AccountSession;
}

const label = (c: OidbCall) => `0x${c.command.toString(16)}_${c.subCommand}`;

describe('FlashTransferService 发送时序', () => {
  let dir = '';
  let coverPath = '';
  let mainPath = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weq-flash-order-'));
    coverPath = join(dir, 'cover.png');
    mainPath = join(dir, 'passwd');
    await writeFile(coverPath, tinyPng());
    await writeFile(mainPath, Buffer.alloc(2429, 7));
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('封面在 0x93d7 之前传完，主文件留在发送之后', async () => {
    const nt = fakeNative();
    const svc = new FlashTransferService(nt, fakeSession(), () => PID);

    const result = await svc.sendFlashTransfer({
      files: [{ path: mainPath }],
      peerType: 'c2c',
      targetId: '20002',
      thumbPath: coverPath,
      uploader: { uin: '10001', nickname: 'me', uid: 'u_me' },
    });
    await result.uploaded;

    expect(result.filesetUuid).toBe(FILESET);

    // 全序列逐条钉死：封面（0x12a9 第一对）必须在 0x93d7 之前，
    // 主文件（0x12a9 第二对）与 0x93d1 在 0x93d7 之后。
    expect(nt.calls.map(label)).toEqual([
      '0x93cf_1',
      '0x93d0_1',
      '0x93db_1',
      '0x12a9_100', // 封面 prepare
      '0x12a9_103', // 封面 apply（报备进 fileset）
      '0x93d7_1', // 发消息 —— 必须晚于封面
      '0x12a9_100', // 主文件 prepare
      '0x12a9_103', // 主文件 apply
      '0x93d1_1', // fileset 状态
    ]);

    const send = nt.calls.findIndex((c) => c.command === 0x93d7);
    const coverPrepares = nt.calls
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.command === 0x12a9);
    const coverApply = coverPrepares[1]!; // 第二笔 0x12a9 = 封面 apply
    const firstMain = coverPrepares[2]!; // 第三笔 0x12a9 = 主文件 prepare

    expect(send).toBeGreaterThan(coverApply.i);
    expect(firstMain.i).toBeGreaterThan(send);
    expect(nt.calls.every((c) => c.pid === PID)).toBe(true);
  });

  it('封面报备带 fileset 标记（payload.f2=1 / filesetWrap.f5=1），主文件不带', async () => {
    const nt = fakeNative();
    const svc = new FlashTransferService(nt, fakeSession(), () => PID);
    const result = await svc.sendFlashTransfer({
      files: [{ path: mainPath }],
      peerType: 'c2c',
      targetId: '20002',
      thumbPath: coverPath,
      uploader: { uin: '10001', nickname: 'me', uid: 'u_me' },
    });
    await result.uploaded;

    const prep = nt.calls.filter((c) => c.command === 0x12a9 && c.subCommand === 100);
    const roleOf = (body: Uint8Array) =>
      (decode(PrepareUpload.reqSchema, body) as { payload: { field2: number } }).payload.field2;

    expect(roleOf(prep[0]!.body)).toBe(1); // 封面
    expect(roleOf(prep[1]!.body)).toBe(0); // 主文件
  });
});
