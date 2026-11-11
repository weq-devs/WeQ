import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import {
  buildDatalineBlock,
  parseDatalineBlockAck,
  DATALINE_FTN_MAGIC,
} from '../src/file/dataline-block';
import {
  sendDatalineFile,
  DATALINE_UPLOAD_CMD,
  DATALINE_UPLOAD_REQUEST,
  DATALINE_UPLOAD_RESPONSE,
  DATALINE_UPLOAD_ATTEMPTS,
} from '../src/file/dataline-file';
import { buildSendRequest } from '../src/msg/send';
import { SEND_MESSAGE_REQUEST, SEND_MESSAGE_RESPONSE } from '../src/msg/send-schemas';
import { decode, encode } from '../src/protobuf';
import type { TrpcNative } from '../src/transport';
import { FileChunkSource } from '../src/highway';

let dir = '';
let filePath = '';
const contents = Uint8Array.from({ length: 300 }, (_, i) => i & 255);
const target = {
  selfUin: 10001,
  selfUid: 'u_self',
  deviceUid: 'u_device',
  terminalType: 2 as const,
};
const fileId = '/00000000-0000-0000-0000-000000000001';
beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'weq-dataline-'));
  filePath = join(dir, 'fixture.bin');
  await fs.writeFile(filePath, contents);
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function native(fileExists = false, retCode = 0) {
  const calls: { cmd: string; body: Uint8Array }[] = [];
  const nt: TrpcNative = {
    sendPacket: async (_pid, cmd, bytes) => {
      calls.push({ cmd, body: new Uint8Array(bytes) });
      if (cmd === DATALINE_UPLOAD_CMD)
        return Buffer.from(
          encode(DATALINE_UPLOAD_RESPONSE, {
            command: 1710,
            upload: {
              retCode,
              uuid: fileId,
              key: new Uint8Array([1, 2, 3]),
              blockSize: 128,
              httpsDomain: 'upload.invalid',
              httpsPort: 443,
              fileExists,
            },
          }),
        );
      if (cmd === 'MessageSvc.PbSendMsg')
        return Buffer.from(encode(SEND_MESSAGE_RESPONSE, { result: 0, timestamp1: 1700000000 }));
      throw new Error('不应发送其他命令');
    },
  };
  return { nt, calls };
}
function ack(next: number, complete: boolean): Uint8Array {
  const bytes = Buffer.alloc(25);
  bytes.writeUInt32BE(DATALINE_FTN_MAGIC, 0);
  bytes.writeUInt32BE(9, 12);
  bytes[16] = complete ? 1 : 0;
  bytes.writeUInt32BE(next, 17);
  return bytes;
}

describe('设备 FTN 分块与通知', () => {
  it('按原生序列化布局手工列出的黄金字节', () => {
    const built = buildDatalineBlock({
      uploadKey: new Uint8Array([1, 2]),
      sha1: Uint8Array.from({ length: 20 }, (_, i) => i),
      fileSize: 7n,
      offset: 1n,
      data: new Uint8Array([0xaa, 0xbb, 0xcc]),
      maxPacketBytes: 128,
    });
    expect(Buffer.from(built.packet).toString('hex')).toBe(
      'abcd9876000003ef0000000000000031000201020014000102030405060708090a0b0c0d0e0f101112130000000700000001000000030000000000000000aabbcc',
    );
  });
  it('高字是后置扩展，回执也按低字/高字组合', () => {
    const built = buildDatalineBlock({
      uploadKey: new Uint8Array([1]),
      sha1: new Uint8Array(20),
      fileSize: (3n << 32n) + 99n,
      offset: (2n << 32n) + 17n,
      data: new Uint8Array([7]),
      maxPacketBytes: 128,
    });
    const bytes = Buffer.from(built.packet);
    const at = bytes.length - 21;
    expect([0, 4, 8, 12, 16].map((offset) => bytes.readUInt32BE(at + offset))).toEqual([
      99, 17, 1, 3, 2,
    ]);
    const response = Buffer.from(ack(17, false));
    response.writeUInt32BE(2, 21);
    expect(parseDatalineBlockAck(response).nextOffset).toBe((2n << 32n) + 17n);
    expect(() => parseDatalineBlockAck(response.subarray(0, 24))).toThrow(/不完整/);
    response.writeUInt32BE(42, 4);
    expect(() => parseDatalineBlockAck(response)).toThrow(/42/);
  });
  it('分块范围和整包上限在网络前校验', () => {
    const base = {
      uploadKey: new Uint8Array([1]),
      sha1: new Uint8Array(20),
      fileSize: 10n,
      offset: 9n,
      data: new Uint8Array([1, 2]),
      maxPacketBytes: 128,
    };
    expect(() => buildDatalineBlock(base)).toThrow(/范围/);
    expect(() => buildDatalineBlock({ ...base, offset: 0n, maxPacketBytes: 10 })).toThrow(/限额/);
  });
  it('设备文件采用真实 UID 与终端路由，不携带普通 c2c/ctrl 或正文', () => {
    const built = buildSendRequest({
      dataline: target,
      elements: [],
      datalineFile: {
        fileId,
        fileName: 'a.bin',
        fileSize: 7,
        headMd5: new Uint8Array(16).fill(17),
        originType: 0,
        sessionId: 1n,
        batchId: 1700000000,
      },
    });
    const decoded = decode(SEND_MESSAGE_REQUEST, built.bytes) as {
      routingHead: unknown;
      contentHead: unknown;
      messageBody: { msgContent: Uint8Array };
      clientSequence?: number;
      ctrl?: unknown;
    };
    expect(decoded.routingHead).toEqual({
      trans0x211: {
        ccCmd: 7,
        uid: target.selfUid,
        devices: {
          destination: { appId: 1001, instanceId: 0, terminalType: 2 },
          source: { appId: 1, instanceId: 1, terminalType: 1 },
        },
      },
    });
    expect(decoded.contentHead).toEqual({ type: 1, subType: 0, c2cCmd: 0 });
    expect(decoded.ctrl).toBeUndefined();
    expect(decoded.clientSequence).toBeGreaterThan(0);
    expect(Buffer.from(decoded.messageBody.msgContent).includes(Buffer.from(fileId))).toBe(true);
  });
  it('真实分块路径全部确认后才发送设备通知，不走 NTV2/OIDB', async () => {
    const { nt, calls } = native();
    const received: Uint8Array[] = [];
    let remoteSize = 0;
    const fetcher = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      expect(new URL(String(url)).hostname).toBe('upload.invalid');
      if (!(init?.body instanceof Uint8Array)) throw new Error('缺少分块');
      const bytes = Buffer.from(init.body);
      expect(bytes.length).toBeLessThanOrEqual(128);
      let at = 18 + bytes.readUInt16BE(16);
      const shaLength = bytes.readUInt16BE(at);
      at += 2;
      expect(bytes.subarray(at, at + shaLength)).toEqual(
        createHash('sha1').update(contents).digest(),
      );
      at += shaLength;
      expect(bytes.readUInt32BE(at)).toBe(contents.length);
      expect(bytes.readUInt32BE(at + 4)).toBe(remoteSize);
      const data = bytes.subarray(at + 20);
      expect(data.length).toBe(bytes.readUInt32BE(at + 8));
      expect(new URL(String(url)).searchParams.get('bmd5')).toBe(
        createHash('md5').update(data).digest('hex'),
      );
      received.push(data);
      remoteSize += data.length;
      return new Response(ack(remoteSize, remoteSize === contents.length));
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await sendDatalineFile(nt, 1, { target, filePath });
    expect(result.sent).toBe(true);
    expect(result.uploadedBytes).toBe(contents.length);
    expect(result.fastUpload).toBe(false);
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
    expect(Buffer.concat(received)).toEqual(Buffer.from(contents));
    const request = decode(DATALINE_UPLOAD_REQUEST, calls[0]!.body) as {
      businessId: number;
      clientType: number;
      upload: { senderUin: bigint; receiverUin: bigint };
    };
    expect(request.businessId).toBe(38);
    expect(request.clientType).toBe(104);
    expect(request.upload.senderUin).toBe(BigInt(target.selfUin));
    expect(request.upload.receiverUin).toBe(BigInt(target.selfUin));
    expect(calls.map((call) => call.cmd)).toEqual([DATALINE_UPLOAD_CMD, 'MessageSvc.PbSendMsg']);
  });
  it('秒传不传字节，上传申请失败或回执无进展都不发通知', async () => {
    const fetcher = vi.fn(async () => new Response(ack(0, false)));
    vi.stubGlobal('fetch', fetcher);
    const hit = native(true);
    expect((await sendDatalineFile(hit.nt, 1, { target, filePath })).fastUpload).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    const rejected = native(false, 42);
    await expect(sendDatalineFile(rejected.nt, 1, { target, filePath })).rejects.toThrow(/42/);
    expect(rejected.calls).toHaveLength(1);
    const stalled = native();
    await expect(sendDatalineFile(stalled.nt, 1, { target, filePath })).rejects.toThrow(/偏移/);
    expect(stalled.calls).toHaveLength(1);
  });
  it('身份缺失时不申请；长上传中切号时不继续发布', async () => {
    const absent = native();
    await expect(
      sendDatalineFile(absent.nt, 1, { target: { ...target, selfUid: '' }, filePath }),
    ).rejects.toThrow(/真实 UID/);
    expect(absent.calls).toHaveLength(0);
    let changed = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        changed = true;
        return new Response(ack(65, false));
      }),
    );
    const running = native();
    await expect(
      sendDatalineFile(running.nt, 1, {
        target,
        filePath,
        beforeSend: () => {
          if (changed) throw new Error('account changed');
        },
      }),
    ).rejects.toThrow(/account changed/);
    expect(running.calls).toHaveLength(1);
  });
  it('HTTP 失败、损坏回执和过大回执均关闭文件且不发设备通知', async () => {
    const closed = vi.spyOn(FileChunkSource.prototype, 'close');
    for (const response of [
      new Response('failed', { status: 500 }),
      new Response(new Uint8Array(25)),
      new Response(new Uint8Array(65537)),
    ]) {
      const fetcher = vi.fn(async () => response);
      vi.stubGlobal('fetch', fetcher);
      const { nt, calls } = native();
      await expect(sendDatalineFile(nt, 1, { target, filePath })).rejects.toThrow();
      expect(calls).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(response.status === 500 ? DATALINE_UPLOAD_ATTEMPTS : 1);
    }
    expect(closed).toHaveBeenCalledTimes(3);
  });
  it.each(['HTTP', 'network'])('%s 临时失败只重试相同分块，不重复发设备通知', async (failure) => {
    const packets: Buffer[] = [];
    const fetcher = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      if (!(init?.body instanceof Uint8Array)) throw new Error('缺少分块');
      const bytes = Buffer.from(init.body);
      packets.push(bytes);
      expect(new Headers(init.headers).get('Content-Length')).toBe(String(bytes.length));
      if (packets.length === 1) {
        if (failure === 'network') throw new TypeError('temporary network');
        return new Response('temporary', { status: 503 });
      }
      let at = 18 + bytes.readUInt16BE(16);
      at += 2 + bytes.readUInt16BE(at);
      const end = bytes.readUInt32BE(at + 4) + bytes.readUInt32BE(at + 8);
      return new Response(ack(end, end === contents.length));
    });
    vi.stubGlobal('fetch', fetcher);
    const { nt, calls } = native();
    const result = await sendDatalineFile(nt, 1, { target, filePath });
    expect(result.sent).toBe(true);
    expect(packets[0]).toEqual(packets[1]);
    expect(calls.map((call) => call.cmd)).toEqual([DATALINE_UPLOAD_CMD, 'MessageSvc.PbSendMsg']);
  });
});
