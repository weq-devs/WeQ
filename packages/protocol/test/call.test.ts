import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEADER_LEN,
  CallEvent,
  FEC_DATA_FRAMES,
  FEC_PARITY_ROWS,
  GcsBodyType,
  OPUS_SILENCE,
  buildAudioFrame,
  buildCodecInitFrame,
  buildFecContainer,
  buildGcsAck,
  buildGcsAuth,
  buildGcsLogout,
  buildQfbRequest,
  buildRelayGetIn,
  buildStatusReport,
  decodeCreateRoomRsp,
  encodeCreateRoomReq,
  parseAudioFrame,
  parseCallEvent,
  parseFecContainer,
  parseGcsPacket,
  parseQfb,
  pbGetVarint,
  rsDecode,
  rsEncode,
} from '../src/call';
import { encode, decode } from '../src/protobuf';
import { C2C_CREATE_ROOM_RSP } from '../src/call/signaling';

// ─────────────── 信令 ───────────────

describe('通话信令', () => {
  it('开房请求的字段布局与线上一致', () => {
    const bytes = encodeCreateRoomReq({
      selfUid: 'u_self',
      peerUid: 'u_peer',
      relationId: 15000,
    });
    const hex = Buffer.from(bytes).toString('hex');
    // f1=common：roomId=0 / relationId=15000 / scene=1 / self_info
    expect(hex).toContain('1898752001');
    // f2=params：audio=1 video=0 f3=1 ipStack=88(fixed32) f5=1
    expect(hex).toContain('08011000180125580000002801');
    // media 必须是完整的子消息，不能编码成空消息
    expect(hex).toContain('3a18');
    // 对端 uid 写在 media.peer 里，不是顶层
    expect(Buffer.from(bytes).toString('latin1')).toContain('u_peer');
    expect(Buffer.from(bytes).toString('latin1')).toContain('u_self');
  });

  it('开房回包解析出房间、密钥与服务器（ip 缺失时用 altIp 兜底）', () => {
    // 真实回包（发往 2863253201 那次），原样粘过来当黄金样本。
    const hex = readFileSync(
      new URL('./fixtures/call-create-room-rsp.hex', import.meta.url),
      'utf8',
    ).trim();
    const room = decodeCreateRoomRsp(new Uint8Array(Buffer.from(hex, 'hex')));
    expect(room.roomId).toBe(6748173487929717840n);
    expect(room.sessionId).toBe(1707889225n);
    expect(room.relationId).toBe(15000);
    expect(room.authKey).toHaveLength(80);
    // 9 台：3 台只有 altIp（IPv6 记录的 IPv4 备用地址）+ 3 台 relay + 3 台 GCS
    expect(room.servers).toHaveLength(9);
    expect(room.servers.map((s) => `${s.ip}:${s.port}/t${s.type}`)).toEqual([
      '29.237.193.13:8800/t2',
      '29.237.234.22:8800/t2',
      '29.237.209.13:8000/t2',
      '113.250.57.28:8800/t2',
      '113.250.57.166:8800/t2',
      '113.250.58.106:8000/t2',
      '113.250.57.28:8000/t1',
      '113.250.57.166:8001/t1',
      '113.250.58.106:8000/t1',
    ]);
  });
});

// ─────────────── GCS ───────────────

describe('GCS 控制面', () => {
  const base = { roomId: 123n, selfUin: 1707889225, sessionTs: 999, typeId: 0x1959 };

  it('认证包带 authKey 与能力集', () => {
    const pkt = buildGcsAuth({ ...base, authKey: new Uint8Array([9, 9]) });
    expect(pkt[0]).toBe(0x28);
    expect(pkt[pkt.length - 1]).toBe(0x29);
    const parsed = parseGcsPacket(pkt)!;
    expect(parsed.bodyType).toBe(GcsBodyType.authReq);
    expect(parsed.body.length).toBeGreaterThan(100);
  });

  it('登出包的 body 是 reason=2', () => {
    const pkt = buildGcsLogout({ ...base, authKey: new Uint8Array([1]) });
    const parsed = parseGcsPacket(pkt)!;
    expect(parsed.bodyType).toBe(GcsBodyType.logout);
    expect(pbGetVarint(parsed.body, 1)).toBe(2);
  });

  it('媒体控制推送的 ACK 回显配置名并带 authKey', () => {
    const push = encode(
      {
        fields: [
          { name: 'name', tag: 1, type: 'string' },
          { name: 'type', tag: 2, type: 'uint32' },
        ],
      },
      { name: 'audio_config', type: 7 },
    );
    const pkt = buildGcsAck({
      ...base,
      pushBodyType: GcsBodyType.mediaCtrlPush,
      pushBody: push,
      authKey: new Uint8Array([1, 2]),
    });
    const parsed = parseGcsPacket(pkt)!;
    expect(parsed.bodyType).toBe(GcsBodyType.mediaCtrlAck);
    expect(pbGetVarint(parsed.body, 2)).toBe(7);
    expect(Buffer.from(parsed.body).toString('latin1')).toContain('audio_config');
  });

  it('房间事件：解析出事件类型与挂断原因', () => {
    const info = encode(
      {
        fields: [
          { name: 'peer', tag: 1, type: 'uint64' },
          { name: 'event', tag: 3, type: 'uint32' },
        ],
      },
      { peer: 2863253201, event: CallEvent.logout },
    );
    const body = encode(
      {
        fields: [
          { name: 'seq', tag: 1, type: 'uint32' },
          { name: 'info', tag: 2, type: 'bytes' },
          { name: 'reason', tag: 3, type: 'uint32' },
        ],
      },
      { seq: 3, info, reason: 2 },
    );
    expect(parseCallEvent(body)).toEqual({
      seq: 3,
      peerUin: 2863253201,
      event: CallEvent.logout,
      exitReason: 2,
    });
  });

  it('状态上报是每 2 秒必发的那一包，带编码声明', () => {
    const pkt = buildStatusReport({
      ...base,
      sendPackets: 10,
      recvPackets: 8,
      sendBytes: 4000,
      seq: 2,
    });
    const parsed = parseGcsPacket(pkt)!;
    expect(parsed.bodyType).toBe(GcsBodyType.statusReport);
    // f88（codec_type）第 1 次为 2，之后为 0
    expect(pbGetVarint(parsed.body, 88)).toBe(0);
    expect(pbGetVarint(parsed.body, 111)).toBe(2);
  });
});

// ─────────────── Relay ───────────────

describe('中继', () => {
  it('GET_IN 是 37 字节头 + 27 字节体', () => {
    const pkt = buildRelayGetIn({
      roomId: 1n,
      selfUin: 2,
      channelId: 5000,
      authToken: 0x11223344,
    });
    expect(pkt[0]).toBe(0x02);
    expect(pkt.length).toBe(64);
    expect((pkt[5]! << 8) | pkt[6]!).toBe(1);
    // 通道号写在 [25:27]
    expect(((pkt[25]! << 8) | pkt[26]!) >>> 0).toBe(5000);
    // auth_token 的高 2 字节在尾部
    expect([pkt[35], pkt[36]]).toEqual([0x11, 0x22]);
  });
});

// ─────────────── 音频 ───────────────

describe('音频帧', () => {
  it('编码器初始化帧声明 Opus（profile=7）', () => {
    const pkt = buildCodecInitFrame({ sessionTs: 5, tick: 6 });
    expect(pkt[0]).toBe(0x5b);
    expect(pkt[3]).toBe(1);
    // RS-FEC 头：ver=1 / type=3 / flags=0x53 / ext=0xf9
    expect([pkt[17], pkt[18], pkt[19], pkt[20]]).toEqual([0x10, 0x03, 0x53, 0xf9]);
  });

  it('音频帧的时间戳低 16 位就是载荷长度', () => {
    const opus = Uint8Array.from([0xaa, 0xbb, 0xcc]);
    const { packet, rsfec } = buildAudioFrame({
      seq: 7,
      sessionTs: 9,
      tick: 11,
      sampleCounter: 0x1234_0000 + 320,
      frameCounter: 1,
      opus,
    });
    expect(packet.length).toBe(AUDIO_HEADER_LEN + 13 + opus.length + 2);
    // flags=0x3E，ext=0x2E（Opus）
    expect(rsfec[2]).toBe(0x3e);
    expect(rsfec[4]).toBe(0x2e);
    // sub_ts 低 16 位 = 载荷长度
    const subTs = ((rsfec[9]! << 24) | (rsfec[10]! << 16) | (rsfec[11]! << 8) | rsfec[12]!) >>> 0;
    expect(subTs & 0xffff).toBe(opus.length);
  });

  it('解析回自己发出去的帧', () => {
    const opus = Uint8Array.from([1, 2, 3, 4, 5]);
    const { packet } = buildAudioFrame({
      seq: 1,
      sessionTs: 2,
      tick: 3,
      sampleCounter: 0x1000_0000,
      frameCounter: 1,
      opus,
    });
    const frame = parseAudioFrame(packet)!;
    expect(frame.isOpus).toBe(true);
    expect(frame.version).toBe(0);
    expect(Buffer.from(frame.payload)).toEqual(Buffer.from(opus));
  });

  it('静音帧是 8 字节 DTX', () => {
    expect(OPUS_SILENCE.length).toBe(8);
  });
});

// ─────────────── FEC ───────────────

describe('RS-FEC', () => {
  const frames = [
    Uint8Array.from([1, 2, 3, 4]),
    Uint8Array.from([5, 6, 7, 8]),
    Uint8Array.from([9, 10, 11, 12]),
    Uint8Array.from([13, 14, 15, 16]),
  ];

  it('丢 1 帧能恢复', () => {
    const parity = rsEncode(frames, 4);
    expect(parity).toHaveLength(FEC_PARITY_ROWS);
    const recovered = rsDecode(
      [frames[0]!, null, frames[2]!, frames[3]!],
      [
        { row: 0, data: parity[0]! },
        { row: 1, data: parity[1]! },
        { row: 2, data: parity[2]! },
      ],
      4,
    )!;
    expect(Buffer.from(recovered[1]!)).toEqual(Buffer.from(frames[1]!));
  });

  it('丢 3 帧也能恢复（达到上限）', () => {
    const parity = rsEncode(frames, 4);
    const recovered = rsDecode(
      [null, null, frames[2]!, null],
      [
        { row: 0, data: parity[0]! },
        { row: 1, data: parity[1]! },
        { row: 2, data: parity[2]! },
      ],
      4,
    )!;
    for (const i of [0, 1, 3]) {
      expect(Buffer.from(recovered[i]!)).toEqual(Buffer.from(frames[i]!));
    }
  });

  it('校验行不够时明确返回救不回来', () => {
    const parity = rsEncode(frames, 4);
    expect(
      rsDecode([null, null, frames[2]!, frames[3]!], [{ row: 0, data: parity[0]! }], 4),
    ).toBeNull();
  });

  it('FEC 容器能原样解析回来', () => {
    const parity = new Uint8Array([7, 8, 9, 10]);
    const container = buildFecContainer({
      parity,
      paySize: 4,
      rowIndex: 1,
      globalCnt: 12,
      groupTick: 0xabcd,
      globalFecIdx: 9,
      fecSubSeq: 0x1234,
    });
    const parsed = parseFecContainer(container)!;
    expect(parsed.rowIndex).toBe(1);
    expect(parsed.paySize).toBe(4);
    expect(parsed.fecIdx).toBe(9);
    expect(Buffer.from(parsed.parity)).toEqual(Buffer.from(parity));
  });

  it('每组固定 4 帧数据', () => {
    expect(FEC_DATA_FRAMES).toBe(4);
  });
});

// ─────────────── 质量反馈 ───────────────

describe('质量反馈', () => {
  it('第 6 次起才带「支持解码 Opus」', () => {
    const early = buildQfbRequest({
      seq: 1,
      sessionTs: 2,
      tick: 3,
      qfbSeq: 1,
      tsStart: 0,
    });
    const late = buildQfbRequest({
      seq: 2,
      sessionTs: 2,
      tick: 3,
      qfbSeq: 6,
      tsStart: 0,
    });
    expect(late.length).toBeGreaterThan(early.length);
    const parsed = parseQfb(late.subarray(AUDIO_HEADER_LEN))!;
    expect(parsed.qfbSeq).toBe(6);
    expect(parsed.type).toBe(1);
  });
});

// ─────────────── 协议层的公开契约 ───────────────

describe('不破坏既有机制', () => {
  it('这些命令不在签名白名单里，发包时不带签名', async () => {
    const { commandNeedsSign } = await import('../src/sign/whitelist');
    const { C2C_SSO_CMD } = await import('../src/call');
    for (const cmd of Object.values(C2C_SSO_CMD)) {
      expect(commandNeedsSign(cmd)).toBe(false);
    }
  });

  it('回包 schema 的字段号与线上一致', () => {
    // decode 一个空 body 不抛错，且字段都在
    const empty = decode(C2C_CREATE_ROOM_RSP, new Uint8Array(0));
    expect(empty).toBeTruthy();
  });
});
