/**
 * 文件发送（群文件 / 私聊文件）离线测试。
 *
 * 联网部分用一个「服务端已持有该 md5」的申请响应绕开（`boolFileExist: true`
 * ⇒ 不做 highway PUT），这样整条链路可以离线跑完，并把**请求字节**解回来断言：
 * 命令号、0x6D6_0 的 file 段、0x6D9_4 的 body、0xE37_1700 的 upload 段、以及
 * 私聊那条 PbSendMsg 的 `trans0x211` 路由 + `msgContent` 里的 FileExtra。
 *
 * 覆盖：
 *   - hashFileStreaming 的「前 10 MiB = 0x98A000」口径；
 *   - 两种 highway FileUploadExt（群 busiBuff 带群号 / 私聊只带 senderUin）；
 *   - sendGroupFile：申请 → 发布；
 *   - sendPrivateFile：申请 → finalize → PbSendMsg；
 *   - buildSendC2cFileRequest：trans0x211 + msgContent。
 */

import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendGroupFile, sendPrivateFile } from '../src/file';
import { decode, encode } from '../src/protobuf';
import {
  OIDB_GROUP_FILE_UPLOAD_REQ,
  OIDB_GROUP_FILE_UPLOAD_RESP,
  OIDB_GROUP_SEND_FILE_REQ,
  OIDB_OFFLINE_FILE_FINALIZE_RESP,
  OIDB_PRIVATE_FILE_UPLOAD_REQ,
  OIDB_PRIVATE_FILE_UPLOAD_RESP,
} from '../src/oidb/file-upload-schemas';
import {
  FILE_UPLOAD_EXT,
  FILE_MD5_HEAD_LIMIT,
  hashFileStreaming,
  ipv4ToString,
} from '../src/highway';
import { buildSendC2cFileRequest } from '../src/msg/send';
import { SEND_MESSAGE_REQUEST, SEND_MESSAGE_RESPONSE } from '../src/msg/send-schemas';
import { FILE_EXTRA } from '../src/msg/schemas';

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
}
interface PacketCall {
  pid: number;
  cmd: string;
  body: Uint8Array;
}

function makeNative(handlers: {
  oidb: (call: OidbCall) => Uint8Array;
  packet?: (call: PacketCall) => Uint8Array;
}) {
  const oidbCalls: OidbCall[] = [];
  const packetCalls: PacketCall[] = [];
  return {
    oidbCalls,
    packetCalls,
    sendOidbPacket: async (
      pid: number,
      command: number,
      subCommand: number,
      body: Buffer,
      isUid: boolean,
    ): Promise<Buffer> => {
      const call = { pid, command, subCommand, body: new Uint8Array(body), isUid };
      oidbCalls.push(call);
      return Buffer.from(handlers.oidb(call));
    },
    sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
      const call = { pid, cmd, body: new Uint8Array(body) };
      packetCalls.push(call);
      if (!handlers.packet) throw new Error(`未预期的 sendPacket: ${cmd}`);
      return Buffer.from(handlers.packet(call));
    },
  };
}

let dir = '';
let filePath = '';
let bigPath = '';
const payload = Buffer.from('WeQ file send test — hello 文件喵\n'.repeat(64));
// 比 head limit 大一点，用来验「前 0x98A000 字节」的口径。
const bigPayload = Buffer.alloc(FILE_MD5_HEAD_LIMIT + 4096, 0x5a);

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(tmpdir(), 'weq-file-'));
  filePath = path.join(dir, 'note.txt');
  await fsp.writeFile(filePath, payload);
  bigPath = path.join(dir, 'big.bin');
  await fsp.writeFile(bigPath, bigPayload);
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('hashFileStreaming', () => {
  it('整文件 md5/sha1 + 前 headLimit 字节的 md5', async () => {
    const hashes = await hashFileStreaming(filePath, { headLimit: FILE_MD5_HEAD_LIMIT });
    expect(hashes.fileSize).toBe(payload.length);
    expect(hashes.md5Hex).toBe(createHash('md5').update(payload).digest('hex'));
    expect(hashes.sha1Hex).toBe(createHash('sha1').update(payload).digest('hex'));
    // 文件比 limit 小 ⇒ 前 N 字节的 md5 == 整文件 md5。
    expect(Buffer.from(hashes.headMd5!).toString('hex')).toBe(hashes.md5Hex);
  });

  it('比 limit 大时前 N 字节的 md5 只覆盖前 0x98A000 字节', async () => {
    const hashes = await hashFileStreaming(bigPath, { headLimit: FILE_MD5_HEAD_LIMIT });
    const expected = createHash('md5')
      .update(bigPayload.subarray(0, FILE_MD5_HEAD_LIMIT))
      .digest('hex');
    expect(Buffer.from(hashes.headMd5!).toString('hex')).toBe(expected);
    expect(hashes.md5Hex).toBe(createHash('md5').update(bigPayload).digest('hex'));
    // 口径必须正好是 0x98A000，不是 10*1024*1024。
    expect(FILE_MD5_HEAD_LIMIT).toBe(0x98a000);
  });

  it('不给 headLimit 时 headMd5 为 null', async () => {
    const hashes = await hashFileStreaming(filePath);
    expect(hashes.headMd5).toBeNull();
  });
});

describe('sendGroupFile', () => {
  it('申请 0x6D6_0（file 段）→ 命中秒传 → 发布 0x6D9_4', async () => {
    const native = makeNative({
      oidb: (call) => {
        if (call.command === 0x6d6 && call.subCommand === 0) {
          return encode(OIDB_GROUP_FILE_UPLOAD_RESP, {
            upload: { retCode: 0, fileId: 'fileid-123', boolFileExist: true, busId: 102 },
          });
        }
        if (call.command === 0x6d9 && call.subCommand === 4) return new Uint8Array(0);
        throw new Error(`未预期的 OIDB ${call.command.toString(16)}_${call.subCommand}`);
      },
    });

    const result = await sendGroupFile(native, 7, {
      groupId: 673646675,
      filePath,
      selfUin: 3433285587,
    });

    expect(result.fileId).toBe('fileid-123');
    expect(result.fastUpload).toBe(true);
    expect(result.published).toBe(true);
    expect(result.fileSize).toBe(payload.length);

    // 申请请求形状。
    const req = decode(OIDB_GROUP_FILE_UPLOAD_REQ, native.oidbCalls[0]!.body) as {
      file?: {
        groupUin?: number;
        appId?: number;
        busId?: number;
        entrance?: number;
        targetDirectory?: string;
        fileName?: string;
        localDirectory?: string;
        fileSize?: bigint;
        fileSha1?: Uint8Array;
        fileSha3?: Uint8Array;
        fileMd5?: Uint8Array;
        field15?: boolean;
      };
    };
    expect(native.oidbCalls[0]!.command).toBe(0x6d6);
    expect(native.oidbCalls[0]!.subCommand).toBe(0);
    expect(native.oidbCalls[0]!.isUid).toBe(true);
    expect(req.file?.groupUin).toBe(673646675);
    expect(req.file?.appId).toBe(4);
    expect(req.file?.busId).toBe(102);
    expect(req.file?.entrance).toBe(6);
    expect(req.file?.targetDirectory).toBe('/');
    expect(req.file?.fileName).toBe('note.txt');
    expect(req.file?.localDirectory).toBe('/note.txt');
    expect(Number(req.file?.fileSize)).toBe(payload.length);
    expect(Buffer.from(req.file!.fileMd5!).toString('hex')).toBe(result.md5Hex);
    expect(Buffer.from(req.file!.fileSha1!).toString('hex')).toBe(result.sha1Hex);
    expect(req.file?.field15).toBe(true);

    // 发布请求形状（body 在 tag 5）。
    const publish = native.oidbCalls[1]!;
    expect(publish.command).toBe(0x6d9);
    expect(publish.subCommand).toBe(4);
    const body = decode(OIDB_GROUP_SEND_FILE_REQ, publish.body) as {
      body?: {
        groupUin?: number;
        type?: number;
        info?: { busiType?: number; fileId?: string; field3?: number; field5?: boolean };
      };
    };
    expect(body.body?.groupUin).toBe(673646675);
    expect(body.body?.type).toBe(2);
    expect(body.body?.info?.busiType).toBe(102);
    expect(body.body?.info?.fileId).toBe('fileid-123');
    expect(body.body?.info?.field5).toBe(true);
    expect(body.body?.info?.field3).toBeGreaterThanOrEqual(0);
    expect(body.body?.info?.field3).toBeLessThan(0x80000000);
  });

  it('publish: false 时不发 0x6D9_4', async () => {
    const native = makeNative({
      oidb: () =>
        encode(OIDB_GROUP_FILE_UPLOAD_RESP, {
          upload: { retCode: 0, fileId: 'fid', boolFileExist: true },
        }),
    });
    const result = await sendGroupFile(native, 7, {
      groupId: 1,
      filePath,
      selfUin: 100,
      publish: false,
    });
    expect(result.published).toBe(false);
    expect(native.oidbCalls).toHaveLength(1);
  });

  it('申请被拒时抛错', async () => {
    const native = makeNative({
      oidb: () =>
        encode(OIDB_GROUP_FILE_UPLOAD_RESP, {
          upload: { retCode: 1, retMsg: 'no permission', clientWording: '没有权限' },
        }),
    });
    await expect(sendGroupFile(native, 7, { groupId: 1, filePath, selfUin: 100 })).rejects.toThrow(
      /群文件上传申请 failed/,
    );
  });
});

describe('sendPrivateFile', () => {
  it('申请 0xE37_1700 → finalize 0xE37_800 → PbSendMsg（trans0x211 + msgContent）', async () => {
    const native = makeNative({
      oidb: (call) => {
        if (call.command === 0xe37 && call.subCommand === 1700) {
          return encode(OIDB_PRIVATE_FILE_UPLOAD_RESP, {
            upload: { retCode: 0, uuid: 'uuid-abc', fileAddon: 'addon-xyz', boolFileExist: true },
          });
        }
        if (call.command === 0xe37 && call.subCommand === 800) {
          return encode(OIDB_OFFLINE_FILE_FINALIZE_RESP, {
            body: {
              field10: 1,
              metadata: {
                field3: 7,
                field100: new Uint8Array([0xaa]),
                field101: new Uint8Array([0xbb]),
                field110: 42,
                timestamp1: 1790000000,
              },
            },
          });
        }
        throw new Error(`未预期的 OIDB ${call.command.toString(16)}_${call.subCommand}`);
      },
      packet: () =>
        encode(SEND_MESSAGE_RESPONSE, {
          result: 0,
          privateSequence: 1966,
          timestamp1: 1790213320,
        }),
    });

    const result = await sendPrivateFile(native, 7, {
      userUid: 'u_TEST',
      selfUid: 'u_SELF',
      selfUin: 3433285587,
      filePath,
    });

    expect(result.fileId).toBe('uuid-abc');
    expect(result.fileHash).toBe('addon-xyz');
    expect(result.fastUpload).toBe(true);
    expect(result.finalized).toBe(true);
    expect(result.sent).toBe(true);
    expect(result.receipt?.privateSequence).toBe(1966);

    // 申请请求（含 md510MCheckSum）。
    const uploadReq = decode(OIDB_PRIVATE_FILE_UPLOAD_REQ, native.oidbCalls[0]!.body) as {
      command?: number;
      seq?: number;
      upload?: {
        senderUid?: string;
        receiverUid?: string;
        fileSize?: number;
        fileName?: string;
        md510MCheckSum?: Uint8Array;
        sha1CheckSum?: Uint8Array;
        localPath?: string;
        md5CheckSum?: Uint8Array;
      };
      businessId?: number;
      clientType?: number;
      flagSupportMediaPlatform?: number;
    };
    expect(uploadReq.command).toBe(1700);
    expect(uploadReq.upload?.senderUid).toBe('u_SELF');
    expect(uploadReq.upload?.receiverUid).toBe('u_TEST');
    expect(uploadReq.upload?.fileSize).toBe(payload.length);
    expect(uploadReq.upload?.fileName).toBe('note.txt');
    expect(uploadReq.upload?.localPath).toBe('/');
    expect(Buffer.from(uploadReq.upload!.md5CheckSum!).toString('hex')).toBe(result.md5Hex);
    expect(uploadReq.businessId).toBe(3);
    expect(uploadReq.clientType).toBe(1);
    expect(uploadReq.flagSupportMediaPlatform).toBe(1);

    // finalize 请求形状。
    const fin = native.oidbCalls[1]!;
    expect(fin.command).toBe(0xe37);
    expect(fin.subCommand).toBe(800);

    // 发送：trans0x211 路由 + msgContent（不是 richText.elems）。
    expect(native.packetCalls).toHaveLength(1);
    const sent = decode(SEND_MESSAGE_REQUEST, native.packetCalls[0]!.body) as {
      routingHead?: { trans0x211?: { ccCmd?: number; uid?: string } };
      contentHead?: { type?: number };
      messageBody?: { richText?: unknown; msgContent?: Uint8Array };
      ctrl?: { msgFlag?: number };
    };
    expect(native.packetCalls[0]!.cmd).toBe('MessageSvc.PbSendMsg');
    expect(sent.routingHead?.trans0x211?.ccCmd).toBe(4);
    expect(sent.routingHead?.trans0x211?.uid).toBe('u_TEST');
    expect(sent.contentHead?.type).toBe(1);
    expect(sent.messageBody?.richText).toBeUndefined();
    expect(sent.ctrl?.msgFlag).toBeGreaterThan(0);

    const extra = decode(FILE_EXTRA, sent.messageBody!.msgContent!) as {
      file?: {
        fileType?: number;
        fileUuid?: string;
        fileName?: string;
        fileMd5?: Uint8Array;
        fileSize?: bigint;
        subcmd?: number;
        dangerEvel?: number;
        fileHash?: string;
      };
      field6?: {
        field2?: {
          field1?: number;
          fileUuid?: string;
          field6?: number;
          field7?: Uint8Array;
          field8?: Uint8Array;
          selfUid?: string;
          destUid?: string;
        };
      };
    };
    expect(extra.file?.fileType).toBe(0);
    expect(extra.file?.fileUuid).toBe('uuid-abc');
    expect(extra.file?.fileName).toBe('note.txt');
    expect(extra.file?.subcmd).toBe(1);
    expect(extra.file?.dangerEvel).toBe(0);
    expect(extra.file?.fileHash).toBe('addon-xyz');
    expect(Number(extra.file?.fileSize)).toBe(payload.length);
    expect(extra.field6?.field2?.field110 ?? extra.field6?.field2?.field1).toBe(42);
    expect(extra.field6?.field2?.fileUuid).toBe('uuid-abc');
    expect(extra.field6?.field2?.field6).toBe(7);
    expect(extra.field6?.field2?.selfUid).toBe('u_SELF');
    expect(extra.field6?.field2?.destUid).toBe('u_TEST');
  });

  it('finalize 失败不影响发送（只是不带 field6）', async () => {
    const native = makeNative({
      oidb: (call) => {
        if (call.command === 0xe37 && call.subCommand === 1700) {
          return encode(OIDB_PRIVATE_FILE_UPLOAD_RESP, {
            upload: { retCode: 0, uuid: 'uuid-abc', boolFileExist: true },
          });
        }
        throw new Error('finalize 挂了');
      },
      packet: () => encode(SEND_MESSAGE_RESPONSE, { result: 0, privateSequence: 1 }),
    });
    const result = await sendPrivateFile(native, 7, {
      userUid: 'u_TEST',
      selfUid: 'u_SELF',
      selfUin: 100,
      filePath,
    });
    expect(result.finalized).toBe(false);
    expect(result.sent).toBe(true);
    const sent = decode(SEND_MESSAGE_REQUEST, native.packetCalls[0]!.body) as {
      messageBody?: { msgContent?: Uint8Array };
    };
    const extra = decode(FILE_EXTRA, sent.messageBody!.msgContent!) as { field6?: unknown };
    expect(extra.field6).toBeUndefined();
  });
});

describe('FileUploadExt（highway 扩展）', () => {
  it('群：cmdId 71 的 busiBuff 带群号，checkKey 用响应里的 checkKey', async () => {
    const { buildGroupFileUploadExt } = await import('../src/highway');
    const ext = buildGroupFileUploadExt({
      senderUin: 3433285587,
      groupId: 673646675,
      fileName: 'a.bin',
      fileSize: 10,
      md5: new Uint8Array(16).fill(1),
      checkKey: new Uint8Array([9, 9]),
      fileId: 'fid',
      uploadKey: new Uint8Array([7, 7]),
      uploadHost: '1.2.3.4',
      uploadPort: 80,
    });
    const decoded = decode(FILE_UPLOAD_EXT, ext) as Record<string, unknown>;
    const entry = decoded.entry as Record<string, unknown>;
    const busi = entry.busiBuff as Record<string, unknown>;
    expect(Number(decoded.unknown1)).toBe(100);
    expect(Number(decoded.unknown2)).toBe(1);
    // 0 是 proto3 默认值不上 wire（与 NapCat 实际字节一致）。
    expect(Number(decoded.unknown200 ?? 0)).toBe(0);
    expect(Number(busi.senderUin)).toBe(3433285587);
    expect(Number(busi.receiverUin)).toBe(673646675);
    expect(Number(busi.groupCode)).toBe(673646675);
    // 不能带旧 busId（会让大文件永远 finalize 不了）。
    expect(busi.busId ?? 0).toBe(0);
    const fileEntry = entry.fileEntry as Record<string, unknown>;
    expect(Buffer.from(fileEntry.checkKey as Uint8Array).toString('hex')).toBe('0909');
    expect(Buffer.from(fileEntry.uploadKey as Uint8Array).toString('hex')).toBe('0707');
  });

  it('私聊：busiBuff 只带 senderUin，checkKey 用 sha1，unknown200=1', async () => {
    const { buildPrivateFileUploadExt } = await import('../src/highway');
    const ext = buildPrivateFileUploadExt({
      senderUin: 3433285587,
      fileName: 'a.bin',
      fileSize: 10,
      md5: new Uint8Array(16).fill(1),
      sha1: new Uint8Array([5, 5, 5]),
      fileId: 'uuid',
      uploadKey: new Uint8Array([8, 8]),
      uploadHost: '1.2.3.4',
      uploadPort: 443,
    });
    const decoded = decode(FILE_UPLOAD_EXT, ext) as Record<string, unknown>;
    const entry = decoded.entry as Record<string, unknown>;
    const busi = entry.busiBuff as Record<string, unknown>;
    expect(Number(decoded.unknown200)).toBe(1);
    expect(Number(decoded.unknown3 ?? 0)).toBe(0);
    expect(Number(busi.senderUin)).toBe(3433285587);
    expect(busi.receiverUin ?? 0).toBe(0);
    expect(busi.groupCode ?? 0).toBe(0);
    const fileEntry = entry.fileEntry as Record<string, unknown>;
    expect(Buffer.from(fileEntry.checkKey as Uint8Array).toString('hex')).toBe('050505');
  });
});

describe('buildSendC2cFileRequest', () => {
  it('空 uid / 空 fileExtra 直接抛错', () => {
    expect(() =>
      buildSendC2cFileRequest({ userUid: '  ', fileExtra: new Uint8Array([1]) }),
    ).toThrow(/userUid/);
    expect(() => buildSendC2cFileRequest({ userUid: 'u', fileExtra: new Uint8Array(0) })).toThrow(
      /fileExtra/,
    );
  });
});

describe('ipv4ToString', () => {
  it('按线上小端解（最低字节是点分串第一段）', () => {
    // 10.0.0.1 → 小端打包 = 0x0100000A
    expect(ipv4ToString(0x0100000a)).toBe('10.0.0.1');
    expect(ipv4ToString(0xc0a80101)).toBe('1.1.168.192');
  });
});
