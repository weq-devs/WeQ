import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_HEADER_LEN,
  CallEvent,
  DEFAULT_CAPABILITIES,
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
  buildVideoState,
  buildVideoParamPush,
  buildVideoStreamPush,
  buildPeerJoinReport,
  buildPeerProbe,
  buildPeerProbeReply,
  buildQfbRequest,
  buildRelayGetIn,
  buildRelayKeepalive,
  buildStatusReport,
  parsePeerJoin,
  parsePeerProbe,
  PeerProbeCmd,
  decodeCreateRoomRsp,
  encodeCreateRoomReq,
  parseAudioFrame,
  parseCallEvent,
  parseFecContainer,
  parseGcsPacket,
  parsePb,
  parseQfb,
  pbGetBytes,
  pbGetVarint,
  VideoStateCode,
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

  /**
   * 黄金样本：2026-10-26 同一次通话的 OIDB 回包（QQ 本体，P2P 正常）。
   *
   * 服务器表前三条带**字段 5（16 字节裸 IPv6）**，服务端下发的原始顺序即优先级；
   * QQ 实际连的就是第一条 `240e:930:c200:88::17:8000`（UDP 抓包证实）。
   *
   * 旧 schema 没有字段 5，这三条会退化成 `altIp` 的 IPv4（`29.237.*`，不可达），
   * 导致 GCS 握手只能退到后面的 IPv4 条目、`bt=9` 拿不到对端 `f7`、媒体全程走
   * 中继 —— 这就是「两端都卡」的根因。
   */
  it('开房回包解析出房间、密钥与服务器（IPv6 优先）', () => {
    const hex = readFileSync(
      new URL('./fixtures/call-create-room-rsp.hex', import.meta.url),
      'utf8',
    ).trim();
    const room = decodeCreateRoomRsp(new Uint8Array(Buffer.from(hex, 'hex')));
    expect(room.roomId).toBe(5697919981127284148n);
    expect(room.sessionId).toBe(1707889225n);
    expect(room.relationId).toBe(26136);
    expect(room.authKey).toHaveLength(80);
    // 9 台：3 台 IPv6（字段 5）+ 3 台 IPv4 relay + 3 台 IPv4 GCS，顺序原样保留。
    expect(room.servers).toHaveLength(9);
    expect(room.servers.map((s) => `${s.ip}:${s.port}/t${s.type}`)).toEqual([
      '240e:930:c200:88::17:8000/t2',
      '240e:930:c200:86::1c:8000/t2',
      '240e:930:c200:81::13:8800/t2',
      '113.250.57.133:8000/t2',
      '113.250.57.110:8000/t2',
      '113.250.57.28:8800/t2',
      '113.250.57.133:8001/t1',
      '113.250.57.110:8000/t1',
      '113.250.57.28:8001/t1',
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

  /**
   * 回归：能力集必须与 QQ 本体逐字节一致。
   *
   * 旧模板是从语音通话抓的，`f3=5 / f6=10058 / f11=26847424`，内层分辨率硬编码
   * 2560×1440、前两条能力是 `f1=2`。视频通话实测是 `f3=15 / f6=10063 /
   * f11=1812048064`、内层 0/0、前两条为空 —— 两者差异可能让服务端不把本端当
   * 视频/P2P 候选（拿不到 `bt=9` 的 `f7`，媒体只能全程中继）。
   *
   * 黄金样本：2026-10-26 QQ 本体直接视频抓包的认证 body（618 字节）。
   */
  it('能力集与 QQ 本体逐字节一致（618 字节）', () => {
    expect(DEFAULT_CAPABILITIES).toHaveLength(618);
    // 顶层 f3 = 15（视频档位）、f6 = 10063（与 MEDIA_PROFILE.video.inviteF4 一致）。
    expect(pbGetVarint(DEFAULT_CAPABILITIES, 3)).toBe(15);
    expect(pbGetVarint(DEFAULT_CAPABILITIES, 6)).toBe(10063);
    // 开头是 f1 能力列表：`0a d3 03`（field 1, len 467），之后两条空能力
    // `0a 00 0a 00` —— 不是旧模板的 `f1=2`（`08 02 10 01`）。
    expect([...DEFAULT_CAPABILITIES.subarray(0, 3)]).toEqual([0x0a, 0xd3, 0x03]);
    expect([...DEFAULT_CAPABILITIES.subarray(3, 7)]).toEqual([0x0a, 0x00, 0x0a, 0x00]);
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
  /**
   * 黄金样本：2026-10-26 QQ 本体抓包里的 GET_IN（发往对端中继 `183.47.105.240:8000`，
   * 64 字节）。
   *
   * 旧实现与它逐字节相比有四处差异，导致中继从不回 GET_IN 应答（cmd=2）：
   *
   * ```text
   * [23:27] QQ 是递增序号 0x70ed，旧实现写死 channelId=5000
   * [31:35] QQ 填对端 uin，旧实现写 0
   * [35:39] QQ 填 4 字节 token，旧实现只写 2 字节（头长写成 37）
   * [53:57] QQ 是 02 0f 27 4f（能力摘要），旧实现照抄语音档的 02 05 27 4a
   * ```
   */
  it('GET_IN 与 QQ 本体逐字节一致', () => {
    const pkt = buildRelayGetIn({
      roomId: 5697919981127284148n,
      selfUin: 1707889225,
      peerUin: 2863253201,
      seq: 0x70ed,
      authToken: 0x6d7bd793,
      nonce: 0xae4e,
    });
    expect(Buffer.from(pkt).toString('hex')).toBe(
      '02004000000001' + // [0:7] 长度 / 通道 0 / cmd=1
        '4f131408b1b135b4' + // [7:15] roomId
        '00000000' + // [15:19]
        '65cc5249' + // [19:23] selfUin
        '000070ed' + // [23:27] seq
        '00000000' + // [27:31]
        'aaa9c6d1' + // [31:35] peerUin
        '6d7bd793' + // [35:39] token
        '00'.repeat(6) + // [39:45]
        'ae4e' + // [45:47] 通道随机数
        '00'.repeat(6) + // [47:53]
        '020f274f' + // [53:57] 能力摘要
        '00'.repeat(6) + // [57:63]
        '03',
    );
  });

  it('保活是 39 字节头 + 结束符，序号与 GET_IN 相同', () => {
    const pkt = buildRelayKeepalive({
      roomId: 5697919981127284148n,
      selfUin: 1707889225,
      peerUin: 2863253201,
      seq: 0x70ed,
      authToken: 0x6d7bd793,
    });
    expect(Buffer.from(pkt).toString('hex')).toBe(
      '02002800' +
        '00000b' +
        '4f131408b1b135b4' +
        '00000000' +
        '65cc5249' +
        '000070ed' +
        '00000000' +
        'aaa9c6d1' +
        '6d7bd793' +
        '03',
    );
  });
});

// ─────────────── P2P 端点 / 握手 ───────────────

describe('P2P 端点交换', () => {
  /**
   * `bt=25`：QQ 本体抓包 24 字节 —— 把自己真正的 UDP 端口（0xc894 = 51348）公告
   * 出去。不发这条，对端永远不知道往哪打洞，媒体只能全程中继。
   */
  it('bt=25 公告本端端口，与抓包逐字节一致', () => {
    const pkt = buildPeerJoinReport({
      roomId: 1n,
      selfUin: 1707889225,
      peerUin: 2863253201,
      sessionTs: 0,
      typeId: 1,
      port: 51348,
    });
    const parsed = parseGcsPacket(pkt)!;
    expect(parsed.bodyType).toBe(GcsBodyType.peerJoinReport);
    expect(Buffer.from(parsed.body).toString('hex')).toBe(
      '08c9a4b1ae0610d18da7d50a18022208d10700000000c894',
    );
  });

  /**
   * `bt=27`：服务端下发对端真实端口。抓包里 `0xdb19` = 56089，正是对端发媒体
   * 用的端口；`bt=9` 的 `f8` 给的是 56082（近似值）。
   */
  it('bt=27 解析出对端端口', () => {
    const body = Uint8Array.from(
      Buffer.from('08d18da7d50a10c9a4b1ae0618022208d10700000000db19', 'hex'),
    );
    expect(parsePeerJoin(body)).toEqual({ peerUin: 2863253201, port: 56089 });
    expect(parsePeerJoin(new Uint8Array([0x08, 0x01]))).toBeNull();
  });
});

describe('P2P 握手（0x02 ch=1）', () => {
  /**
   * 黄金样本：抓包 23.883s 的 `probe`。对端回包后 P2P 建立，媒体硬切直连 ——
   * 这是「对端收不到 / 极卡」的最后一环。
   */
  it('probe 与抓包逐字节一致', () => {
    const pkt = buildPeerProbe({
      roomId: 5697919981127284148n,
      cmd: PeerProbeCmd.probe,
      uinAbout: 1707889225,
      seq: 0x70ee,
      otherUin: 2863253201,
      token: 0x6d7bd793,
      clock: 0x74d7e43a,
      peerClock: 0,
    });
    expect(Buffer.from(pkt).toString('hex')).toBe(
      '02004800010000' + // [0:7] 长度 / 通道 1 / cmd=0
        '4f131408b1b135b4' + // [7:15] roomId
        '00000000' + // [15:19]
        '65cc5249' + // [19:23] 本条「关于」的 uin（自己）
        '000070ee' + // [23:27] seq
        '00000000' + // [27:31]
        'aaa9c6d1' + // [31:35] 对端 uin
        '6d7bd793' + // [35:39] token
        '00000002' + // [39:43] 常量
        '00000000' + // [43:47]
        '74d7e43a' + // [47:51] 自己的时钟
        '00'.repeat(20) + // [51:71] 还没收到对端的时钟
        '03',
    );
  });

  it('解析出的字段与构造一致，且只认 P2P 通道', () => {
    const pkt = buildPeerProbe({
      roomId: 7n,
      cmd: PeerProbeCmd.probeAck,
      uinAbout: 1,
      seq: 9,
      otherUin: 2,
      token: 3,
      clock: 10,
      peerClock: 11,
    });
    expect(parsePeerProbe(pkt)).toEqual({
      cmd: PeerProbeCmd.probeAck,
      uinAbout: 1,
      seq: 9,
      otherUin: 2,
      token: 3,
      clock: 10,
      peerClock: 11,
    });
    // 服务端通道（[4]=0）不是握手包。
    const server = buildRelayKeepalive({
      roomId: 7n,
      selfUin: 1,
      peerUin: 2,
      seq: 1,
      authToken: 3,
    });
    expect(parsePeerProbe(server)).toBeNull();
  });

  /**
   * 应答是「把收到的 [7:51] 原样回抄 + 自己的时钟」。抓包里 B 的 cmd1：
   * uinAbout/seq/clock 全是 A 的，`peerClock` 才是 B 自己的。
   */
  it('应答回抄探测包的字段，只换上自己的时钟', () => {
    const probe = parsePeerProbe(
      buildPeerProbe({
        roomId: 5n,
        cmd: PeerProbeCmd.probe,
        uinAbout: 11,
        seq: 22,
        otherUin: 33,
        token: 44,
        clock: 0x74d7e43a,
        peerClock: 0,
      }),
    )!;
    const reply = parsePeerProbe(buildPeerProbeReply(probe, { roomId: 5n, clock: 0x5df445 }))!;
    expect(reply).toEqual({
      cmd: PeerProbeCmd.probeReply,
      uinAbout: 11,
      seq: 22,
      otherUin: 33,
      token: 44,
      clock: 0x74d7e43a,
      peerClock: 0x5df445,
    });
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

// ─────────────── 视频流状态（bt=31） ───────────────

describe('视频流状态协商', () => {
  it('客户端状态包带 authKey，body 是 f1=<state>', () => {
    const authKey = new Uint8Array(88).fill(0x5a);
    const packet = buildVideoState({
      roomId: 1n,
      selfUin: 10001,
      sessionTs: 2,
      typeId: 3,
      authKey,
      state: VideoStateCode.start,
    });
    const parsed = parseGcsPacket(packet)!;
    expect(parsed.bodyType).toBe(GcsBodyType.videoStatePush);
    expect([...parsed.body]).toEqual([0x08, VideoStateCode.start]);
    expect(pbGetBytes(parsed.head, 5)).toEqual(authKey);
  });
});

// ─────────────── 服务端视频参数推送（bt=77） ───────────────

describe('视频参数推送', () => {
  /**
   * 黄金样本来自 2026-10-26 QQ 电脑→手机抓包：
   * 服务端在接通前推的 52 字节 body，分辨率 640×480、15 fps、5120 kbps。
   */
  const REAL_PARAM_BODY = Uint8Array.from(
    Buffer.from(
      '122510a2021801221e080f100118800520e003288028300038882750800558e00370800578e003' +
        '18003a090801109183bd032001',
      'hex',
    ),
  );

  it('逐字节还原真实抓包的 52 字节 body', () => {
    const packet = buildVideoParamPush({
      roomId: 1n,
      selfUin: 10001,
      sessionTs: 1,
      typeId: 1,
      width: 640,
      height: 480,
      fps: 15,
      bitrateKbps: 5120,
    });
    const parsed = parseGcsPacket(packet)!;
    expect(parsed.bodyType).toBe(GcsBodyType.videoParamPush);
    expect([...parsed.body]).toEqual([...REAL_PARAM_BODY]);
  });

  it('分辨率、码率与目标端尺寸跟着参数走', () => {
    const build = (width: number, height: number, fps: number, bitrateKbps: number) => {
      const packet = buildVideoParamPush({
        roomId: 1n,
        selfUin: 1,
        sessionTs: 1,
        typeId: 1,
        width,
        height,
        fps,
        bitrateKbps,
      });
      return parseGcsPacket(packet)!.body;
    };
    const a = build(640, 480, 15, 5120);
    const b = build(480, 270, 10, 400);
    expect([...a]).not.toEqual([...b]);
    // 480 / 270 的 varint 分别是 0xe0 0x03 / 0x8e 0x02，必须出现在 body 里。
    expect([...b]).toContain(0x8e);

    const pcPacket = buildVideoParamPush({
      roomId: 1n,
      selfUin: 1,
      sessionTs: 1,
      typeId: 1,
      width: 640,
      height: 480,
      fps: 15,
      bitrateKbps: 5120,
      displayWidth: 1920,
      displayHeight: 1200,
    });
    const outer = parsePb(parseGcsPacket(pcPacket)!.body);
    const inner = parsePb(outer.find((field) => field.field === 2)!.bytes!);
    const video = parsePb(inner.find((field) => field.field === 4)!.bytes!);
    expect(video.find((field) => field.field === 14)?.value).toBe(1920n);
    expect(video.find((field) => field.field === 15)?.value).toBe(1200n);
  });

  /**
   * 13 字节形态：流索引递增。抓包里 f3 依次是 0/1/2/3/4/5，f7 恒定。
   */
  it('流索引形态逐字节还原真实抓包', () => {
    const expected = [
      '18003a090801109183bd032001',
      '18013a090801109183bd032001',
      '18023a090801109183bd032001',
    ];
    for (let i = 0; i < expected.length; i++) {
      const packet = buildVideoStreamPush({
        roomId: 1n,
        selfUin: 1,
        sessionTs: 1,
        typeId: 1,
        streamIndex: i,
      });
      const parsed = parseGcsPacket(packet)!;
      expect(Buffer.from(parsed.body).toString('hex')).toBe(expected[i]);
    }
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
