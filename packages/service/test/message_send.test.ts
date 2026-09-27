/**
 * MessageSendService 的纯逻辑单测 + 一次「发出去」的离线集成断言。
 *
 * 覆盖三块最容易静默出错的地方：
 *   1. 目标解析（群号 / QQ 号 / uid 三种写法、媒体必须 uid 的那一档宽松度）；
 *   2. 文本元素拼装（@ 用 pbReserve、引用在最前、@ 与正文之间的空格）；
 *   3. 回执归一化（失败必须 ok=false + hint，不能把「调用了」当「发成功」）。
 *
 * 发消息本身用一个记账 native 打桩：断言真正上 wire 的 `MessageSvc.PbSendMsg`
 * 报文（路由 / 元素），不连任何网络。
 */

import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decode,
  encode,
  GetBuddyRecommendArk,
  GetGroupRecommendArk,
  LOCATION_ARK_CMD,
  LONG_MSG_RESULT,
  message,
  OIDB_GROUP_FILE_UPLOAD_RESP,
  SEND_LONG_MSG_REQ,
  SEND_LONG_MSG_RESP,
  SEND_MESSAGE_REQUEST,
  SEND_MESSAGE_RESPONSE,
} from '@weq/protocol';
import type { AccountSession } from '@weq/account';
import {
  buildMediaElement,
  buildTextElements,
  decimalCoordinate,
  MessageSendService,
  requireArkJson,
  toOutcome,
  type ResolvedSendTarget,
} from '../src/account/message_send';

/** 文件用例用的临时目录（sendFile 需要真实存在的路径）。 */
let dir = '';
beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(tmpdir(), 'weq-svc-file-'));
});
afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

/** 最小会话替身：只提供本服务用到的 context.uin 与 uidMap。 */
function fakeSession(
  options: { uin?: number; uidOf?: Record<string, string>; uinOf?: Record<string, bigint> } = {},
): AccountSession {
  const uidOf = options.uidOf ?? { '10001': 'u_me', '20002': 'u_friend' };
  const uinOf = options.uinOf ?? { u_friend: 20002n, u_me: 10001n };
  return {
    context: { uin: options.uin ?? 10001 },
    uidMap: {
      uidByUin: (uin: bigint) => uidOf[uin.toString()],
      uinByUid: (uid: string) => uinOf[uid],
    },
  } as unknown as AccountSession;
}

interface PacketCall {
  pid: number;
  cmd: string;
  body: Uint8Array;
}

/** 记账 native：SSO 回一条成功响应，OIDB 直接抛（纯文本路径不应该用到）。 */
function fakeNative() {
  const calls: PacketCall[] = [];
  return {
    calls,
    sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
      calls.push({ pid, cmd, body: new Uint8Array(body) });
      return Buffer.from(
        encode(SEND_MESSAGE_RESPONSE, {
          result: 0,
          groupSequence: 42,
          privateSequence: 43,
          timestamp1: 1700000000,
        }),
      );
    },
    sendOidbPacket: async (): Promise<Buffer> => {
      throw new Error('这条用例不该走 OIDB（媒体上传）');
    },
  };
}

describe('buildTextElements', () => {
  it('纯文本只有一个 text 元素', () => {
    expect(buildTextElements({ peerType: 'c2c', targetId: '1', text: 'hi' })).toEqual([
      { kind: 'text', textContent: 'hi' },
    ]);
  });

  it('@ QQ 号：at 元素（带 uin）+ 空格 + 正文', () => {
    expect(
      buildTextElements({ peerType: 'group', targetId: '1', text: '晚上好', at: ['123456'] }),
    ).toEqual([
      { kind: 'at', atTargetUin: 123456 },
      { kind: 'text', textContent: ' ' },
      { kind: 'text', textContent: '晚上好' },
    ]);
  });

  it('@ uid 与 @全体成员：非纯数字当 uid，all 也走 uid 槽位', () => {
    expect(
      buildTextElements({ peerType: 'group', targetId: '1', text: 'x', at: ['u_abc', 'all'] }),
    ).toEqual([
      { kind: 'at', atTargetUid: 'u_abc' },
      { kind: 'at', atTargetUid: 'all' },
      { kind: 'text', textContent: ' ' },
      { kind: 'text', textContent: 'x' },
    ]);
  });

  it('引用回复排在最前，且带上发送者与时间（引用不补多余空格）', () => {
    const elements = buildTextElements({
      peerType: 'group',
      targetId: '1',
      text: '好的',
      replyToMsgSeq: 88,
      replyToSenderUin: 20002,
      replyToMsgTime: 1700000000,
    });
    expect(elements).toEqual([
      { kind: 'reply', origMsgSeq: 88, origSenderUin: 20002, origMsgTime: 1700000000 },
      { kind: 'text', textContent: '好的' },
    ]);
  });

  it('空的 @ 项被丢掉，不产生空 at 元素', () => {
    expect(buildTextElements({ peerType: 'c2c', targetId: '1', text: 'x', at: ['  '] })).toEqual([
      { kind: 'text', textContent: 'x' },
    ]);
  });
});

describe('buildMediaElement', () => {
  it('图片：只带上调用方给的字段', () => {
    expect(
      buildMediaElement({
        peerType: 'group',
        targetId: '1',
        kind: 'image',
        source: '/tmp/a.png',
        subType: 1,
        summary: '[动画表情]',
        width: 300,
        height: 300,
      }),
    ).toEqual({
      kind: 'image',
      source: '/tmp/a.png',
      subType: 1,
      summary: '[动画表情]',
      width: 300,
      height: 300,
    });
  });

  it('语音：SILK 字节 + 时长 + 波形来源', () => {
    const wav = new Uint8Array([1, 2, 3]);
    expect(
      buildMediaElement({
        peerType: 'c2c',
        targetId: '1',
        kind: 'record',
        source: new Uint8Array([9, 9]),
        durationSec: 3,
        waveform: { wav },
      }),
    ).toEqual({
      kind: 'record',
      source: new Uint8Array([9, 9]),
      duration: 3,
      waveform: { wav },
    });
  });

  it('视频：source + 封面 + 尺寸 + 时长', () => {
    expect(
      buildMediaElement({
        peerType: 'group',
        targetId: '1',
        kind: 'video',
        source: '/tmp/v.mp4',
        thumb: '/tmp/t.jpg',
        width: 640,
        height: 360,
        durationSec: 12,
      }),
    ).toEqual({
      kind: 'video',
      source: '/tmp/v.mp4',
      thumb: '/tmp/t.jpg',
      width: 640,
      height: 360,
      duration: 12,
    });
  });

  it('语音：voiceChanged 只在给定时透传（缺省不带）', () => {
    expect(
      buildMediaElement({
        peerType: 'c2c',
        targetId: '1',
        kind: 'record',
        source: new Uint8Array([9]),
      }),
    ).toEqual({ kind: 'record', source: new Uint8Array([9]) });

    expect(
      buildMediaElement({
        peerType: 'c2c',
        targetId: '1',
        kind: 'record',
        source: new Uint8Array([9]),
        voiceChanged: true,
      }),
    ).toEqual({ kind: 'record', source: new Uint8Array([9]), voiceChanged: true });
  });

  it('未知类型 → 报错（不静默发空元素）', () => {
    expect(() =>
      buildMediaElement({ peerType: 'c2c', targetId: '1', kind: 'audio' as never, source: '/x' }),
    ).toThrow(/不支持的媒体类型/);
  });
});

describe('resolveTarget', () => {
  const svc = new MessageSendService(fakeNative() as never, fakeSession(), () => 1);

  it('群聊：纯数字群号', () => {
    expect(svc.resolveTarget('2863253201', 'group', false)).toEqual({
      peerType: 'group',
      scene: 'group',
      uin: 2863253201,
      uid: '',
      targetId: '2863253201',
    });
  });

  it('群聊：非数字直接报错', () => {
    expect(() => svc.resolveTarget('某群', 'group', false)).toThrow(/群号（纯数字）/);
  });

  it('私聊：给 QQ 号 → 本地目录补上 uid', () => {
    expect(svc.resolveTarget('20002', 'c2c', false)).toEqual({
      peerType: 'c2c',
      scene: 'c2c',
      uin: 20002,
      uid: 'u_friend',
      targetId: '20002',
    });
  });

  it('私聊：给 uid → 反查 QQ 号', () => {
    expect(svc.resolveTarget('u_friend', 'c2c', false)).toEqual({
      peerType: 'c2c',
      scene: 'c2c',
      uin: 20002,
      uid: 'u_friend',
      targetId: '20002',
    });
  });

  it('私聊：目录里没有的 uid → 报错并给出去哪拿 uid', () => {
    expect(() => svc.resolveTarget('u_unknown', 'c2c', false)).toThrow(/find_contact/);
  });

  it('私聊：陌生 QQ 号 + 纯文本 → 放行（uid 留空也能发第一句）', () => {
    const target = svc.resolveTarget('30003', 'c2c', false);
    expect(target).toEqual({
      peerType: 'c2c',
      scene: 'c2c',
      uin: 30003,
      uid: '',
      targetId: '30003',
    });
  });

  it('私聊：陌生 QQ 号 + 媒体 → 拦下并说明为什么（服务端只认 uid）', () => {
    expect(() => svc.resolveTarget('30003', 'c2c', true)).toThrow(/必须带 uid/);
  });
});

describe('toOutcome', () => {
  const target: ResolvedSendTarget = {
    peerType: 'group',
    scene: 'group',
    uin: 123,
    uid: '',
    targetId: '123',
  };

  it('媒体上传结果透传：秒传命中写在 uploads 里（没传字节就别让人以为是真上传）', () => {
    const receipt = {
      ok: true,
      scene: 'group' as const,
      cmd: 'MessageSvc.PbSendMsg',
      result: 0,
      errMsg: '',
      groupSequence: 1,
      privateSequence: 0,
      timestamp: 0,
      random: 1,
      clientSequence: 0,
      requestBytes: new Uint8Array(0),
      responseBytes: new Uint8Array(1),
      uploads: [],
      response: {
        result: 0,
        errMsg: '',
        timestamp1: 0,
        groupSequence: 1,
        privateSequence: 0,
        field10: 0,
        timestamp2: 0,
      },
    };
    const report = {
      kind: 'image' as const,
      fileName: 'a.jpg',
      fileSize: 673,
      md5Hex: '2614635c52fe8057eef5d405440547a1',
      fastUpload: true,
    };
    expect(toOutcome(receipt, target).uploads).toBeUndefined();
    expect(toOutcome(receipt, target, [report]).uploads).toEqual([report]);
  });

  it('成功：ok=true 且不带 hint', () => {
    const outcome = toOutcome(
      {
        ok: true,
        scene: 'group',
        cmd: 'MessageSvc.PbSendMsg',
        result: 0,
        errMsg: '',
        groupSequence: 7,
        privateSequence: 0,
        timestamp: 1700000000,
        random: 111,
        clientSequence: 0,
        requestBytes: new Uint8Array(0),
        responseBytes: new Uint8Array(1),
        uploads: [],
        response: {
          result: 0,
          errMsg: '',
          timestamp1: 0,
          groupSequence: 7,
          privateSequence: 0,
          field10: 0,
          timestamp2: 0,
        },
      },
      target,
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.groupSequence).toBe(7);
    // 对账主键是客户端 random（服务端原样回显、也写进本地库 40002）——msgId 那条
    // 推导路径已删，绝不能再冒出来当对账依据（见 send-message.md 第六节）。
    expect(outcome.random).toBe(111);
    expect(outcome).not.toHaveProperty('messageId');
    expect(outcome.hint).toBeUndefined();
    // JSON 安全：没有 bigint / bytes 混进来。
    expect(() => JSON.stringify(outcome)).not.toThrow();
  });

  it('被拒：ok=false 且 hint 解释 result', () => {
    const outcome = toOutcome(
      {
        ok: false,
        scene: 'group',
        cmd: 'MessageSvc.PbSendMsg',
        result: 79,
        errMsg: 'invalid',
        groupSequence: 0,
        privateSequence: 0,
        timestamp: 1,
        random: 2,
        clientSequence: 0,
        requestBytes: new Uint8Array(0),
        responseBytes: new Uint8Array(0),
        uploads: [],
        response: {
          result: 79,
          errMsg: 'invalid',
          timestamp1: 0,
          groupSequence: 0,
          privateSequence: 0,
          field10: 0,
          timestamp2: 0,
        },
      },
      target,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.hint).toMatch(/result=79/);
  });
});

describe('MessageSendService.sendText（离线集成）', () => {
  it('群聊文本：报文路由与元素正确，回执归一化', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 4242);
    const outcome = await svc.sendText({
      peerType: 'group',
      targetId: '2863253201',
      text: '你好',
      at: ['20002'],
      replyToMsgSeq: 88,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.peerType).toBe('group');
    expect(outcome.groupSequence).toBe(42);
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0]!.cmd).toBe('MessageSvc.PbSendMsg');
    expect(native.calls[0]!.pid).toBe(4242);

    const body = decode(SEND_MESSAGE_REQUEST, native.calls[0]!.body) as {
      routingHead?: { grp?: { groupCode?: bigint } };
      messageBody?: { richText?: { elems?: Record<string, unknown>[] } };
    };
    expect(Number(body.routingHead?.grp?.groupCode)).toBe(2863253201);
    const elems = body.messageBody?.richText?.elems ?? [];
    expect(elems).toHaveLength(4);
    expect(elems[0]).toHaveProperty('replyElement');
    expect(elems[1]).toHaveProperty('text');
    expect(elems[3]).toEqual({ text: { str: '你好' } });
  });

  it('私聊文本：routingHead.c2c 带 uin + 解析出的 uid', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await svc.sendText({ peerType: 'c2c', targetId: 'u_friend', text: 'hi' });
    const body = decode(SEND_MESSAGE_REQUEST, native.calls[0]!.body) as {
      routingHead?: { c2c?: { uin?: number; uid?: string } };
    };
    expect(body.routingHead?.c2c?.uin).toBe(20002);
    expect(body.routingHead?.c2c?.uid).toBe('u_friend');
  });

  it('私聊文本：目录里没有 uid 的陌生人也发得出去（不带 uid 字段）', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await svc.sendText({ peerType: 'c2c', targetId: '30003', text: 'hi' });
    const body = decode(SEND_MESSAGE_REQUEST, native.calls[0]!.body) as {
      routingHead?: { c2c?: { uin?: number; uid?: string } };
    };
    expect(body.routingHead?.c2c?.uin).toBe(30003);
    expect(body.routingHead?.c2c?.uid).toBeUndefined();
  });

  it('窗口抖动：私聊路由 + 独占一枚 commonElem(serviceType=2, businessType=1)', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    const outcome = await svc.sendWindowShake({ targetId: 'u_friend' });

    expect(outcome.ok).toBe(true);
    expect(outcome.peerType).toBe('c2c');
    expect(native.calls).toHaveLength(1);

    const body = decode(SEND_MESSAGE_REQUEST, native.calls[0]!.body) as {
      routingHead?: { c2c?: { uin?: number; uid?: string }; grp?: unknown };
      messageBody?: { richText?: { elems?: Record<string, unknown>[] } };
    };
    // 一律走私聊路由：群聊没有「窗口抖动」这个能力。
    expect(body.routingHead?.c2c?.uin).toBe(20002);
    expect(body.routingHead?.c2c?.uid).toBe('u_friend');
    expect(body.routingHead?.grp).toBeUndefined();

    const elems = body.messageBody?.richText?.elems ?? [];
    // 必须独占一条：多带一个元素服务端就会拒绝。
    expect(elems).toHaveLength(1);
    const common = elems[0]!.commonElem as {
      serviceType: number;
      businessType: number;
      pbElem: Uint8Array;
    };
    expect(common.serviceType).toBe(2);
    expect(common.businessType).toBe(1);
    expect(Array.from(common.pbElem)).toEqual([0x08, 0x01]);
  });

  it('空文本当场报错，不发包', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await expect(svc.sendText({ peerType: 'c2c', targetId: '20002', text: '   ' })).rejects.toThrow(
      /文本不能为空/,
    );
    expect(native.calls).toHaveLength(0);
  });

  // ⚠️ 装扮是服务端不收的实验开关（真机实测落库全 0，见 @weq/protocol 的 SendDress）：
  // 这些用例只断言「报文里带了什么」，不代表收端会看到这些装扮。
  it('带装扮：三个 id 随报文发出（装扮 elem 在正文之前）', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await svc.sendText({
      peerType: 'group',
      targetId: '2863253201',
      text: '你好',
      dress: { bubbleId: 2116371, fontId: 54981, widgetId: 104228 },
    });

    const body = decode(SEND_MESSAGE_REQUEST, native.calls[0]!.body) as {
      messageBody?: { richText?: { elems?: Record<string, unknown>[] } };
    };
    const elems = body.messageBody?.richText?.elems ?? [];
    expect(elems).toEqual([
      { generalFlags: { widgetId: 104228, font: { fontId1: 54981 } } },
      { bubble: { id: 2116371 } },
      { text: { str: '你好' } },
    ]);
  });

  it('不带装扮：报文里没有任何装扮 elem（与以前逐字节一致）', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await svc.sendText({ peerType: 'group', targetId: '2863253201', text: '你好' });

    const body = decode(SEND_MESSAGE_REQUEST, native.calls[0]!.body) as {
      messageBody?: { richText?: { elems?: Record<string, unknown>[] } };
    };
    const elems = body.messageBody?.richText?.elems ?? [];
    expect(elems).toEqual([{ text: { str: '你好' } }]);
  });

  it('非法装扮 id：联网之前就拦下', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await expect(
      svc.sendText({
        peerType: 'group',
        targetId: '2863253201',
        text: '你好',
        dress: { fontId: -5 },
      }),
    ).rejects.toThrow(/fontId/);
    expect(native.calls).toHaveLength(0);
  });

  it('媒体但 uid 缺失：联网之前就拦下', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await expect(
      svc.sendMedia({
        peerType: 'c2c',
        targetId: '30003',
        kind: 'image',
        source: '/tmp/a.png',
      }),
    ).rejects.toThrow(/必须带 uid/);
    expect(native.calls).toHaveLength(0);
  });

  it('元素为空当场报错', async () => {
    const svc = new MessageSendService(fakeNative() as never, fakeSession(), () => 1);
    await expect(
      svc.sendElements({ peerType: 'group', targetId: '1', elements: [] }),
    ).rejects.toThrow(/至少需要一个元素/);
  });
});

describe('sendFile（群文件 / 私聊文件）', () => {
  /** 群文件管线用的记账 native：0x6D6_0 回「秒传命中 + fileId」，0x6D9_4 回空。 */
  function groupFileNative() {
    const calls: { command: number; subCommand: number }[] = [];
    return {
      calls,
      sendPacket: async (): Promise<Buffer> => {
        throw new Error('群文件不走 PbSendMsg（发布是 0x6D9_4）');
      },
      sendOidbPacket: async (
        _pid: number,
        command: number,
        subCommand: number,
      ): Promise<Buffer> => {
        calls.push({ command, subCommand });
        if (command === 0x6d6 && subCommand === 0) {
          return Buffer.from(
            encode(OIDB_GROUP_FILE_UPLOAD_RESP, {
              upload: { retCode: 0, fileId: 'fileid-1', boolFileExist: true },
            }),
          );
        }
        if (command === 0x6d9 && subCommand === 4) return Buffer.from(new Uint8Array(0));
        throw new Error(`未预期的 OIDB ${command.toString(16)}_${subCommand}`);
      },
    };
  }

  it('群文件：上传 + 发布，回执带上 fileId / md5 / fastUpload', async () => {
    const filePath = path.join(dir, 'sent.txt');
    const body = 'hello 群文件\n';
    await fsp.writeFile(filePath, body);
    const native = groupFileNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);

    const outcome = await svc.sendFile({ peerType: 'group', targetId: '555', path: filePath });

    expect(outcome.ok).toBe(true);
    expect(outcome.sent).toBe(true);
    expect(outcome.kind).toBe('file');
    expect(outcome.scene).toBe('group');
    expect(outcome.fileId).toBe('fileid-1');
    expect(outcome.fileName).toBe('sent.txt');
    expect(outcome.fileSize).toBe(Buffer.byteLength(body));
    expect(outcome.fastUpload).toBe(true);
    expect(outcome.md5Hex).toMatch(/^[0-9a-f]{32}$/);
    expect(native.calls.map((c) => `${c.command.toString(16)}_${c.subCommand}`)).toEqual([
      '6d6_0',
      '6d9_4',
    ]);
  });

  it('私聊文件但 uid 缺失：联网之前就拦下', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await expect(
      svc.sendFile({ peerType: 'c2c', targetId: '30003', path: '/tmp/x.bin' }),
    ).rejects.toThrow(/必须带 uid/);
    expect(native.calls).toHaveLength(0);
  });

  it('路径为空当场报错', async () => {
    const svc = new MessageSendService(fakeNative() as never, fakeSession(), () => 1);
    await expect(svc.sendFile({ peerType: 'group', targetId: '1', path: '  ' })).rejects.toThrow(
      /路径不能为空/,
    );
  });
});

describe('sendForward（合并转发，离线）', () => {
  /** 记账 native：长消息回 SendLongMsgResp，普通消息回 SendMessageResp。 */
  function forwardNative(resId = 'res-forward') {
    const calls: PacketCall[] = [];
    return {
      calls,
      sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
        calls.push({ pid, cmd, body: new Uint8Array(body) });
        if (cmd.includes('SsoSendLongMsg')) {
          return Buffer.from(encode(SEND_LONG_MSG_RESP, { result: { resId } }));
        }
        return Buffer.from(
          encode(SEND_MESSAGE_RESPONSE, { result: 0, groupSequence: 42, timestamp1: 1700000000 }),
        );
      },
      sendOidbPacket: async (): Promise<Buffer> => {
        throw new Error('这条用例不该走 OIDB');
      },
    };
  }

  it('群聊：先传长消息（SsoSendLongMsg）再发卡片（PbSendMsg）', async () => {
    const native = forwardNative('res-g');
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    const outcome = await svc.sendForward({
      peerType: 'group',
      targetId: '2863253201',
      nodes: [
        { userUin: 20002, nickname: '小明', elements: [{ kind: 'text', textContent: '你好' }] },
      ],
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.resId).toBe('res-g');
    expect(outcome.scene).toBe('group');
    expect(outcome.levels).toBe(1);
    expect(native.calls.map((c) => c.cmd)).toEqual([
      'trpc.group.long_msg_interface.MsgService.SsoSendLongMsg',
      'MessageSvc.PbSendMsg',
    ]);

    // 第一步：长消息请求里是群聊形状（type=3、uid.uid=群号）。
    const longReq = decode(SEND_LONG_MSG_REQ, native.calls[0]!.body) as {
      info?: { type?: number; uid?: { uid?: string }; groupUin?: number };
    };
    expect(longReq.info?.type).toBe(3);
    expect(longReq.info?.uid?.uid).toBe('2863253201');
    expect(longReq.info?.groupUin).toBe(2863253201);

    // 第二步：卡片里带 resId。
    const cardReq = decode(SEND_MESSAGE_REQUEST, native.calls[1]!.body) as {
      routingHead?: { grp?: { groupCode?: number } };
      messageBody?: { richText?: { elems?: { lightApp?: { data: Uint8Array } }[] } };
    };
    expect(cardReq.routingHead?.grp?.groupCode).toBe(2863253201n); // uint64 → bigint
    const card = cardReq.messageBody?.richText?.elems?.[0]?.lightApp;
    expect(card).toBeTruthy();
    const cardJson = JSON.parse(
      inflateSync(Buffer.from(card!.data).subarray(1)).toString('utf8'),
    ) as {
      meta?: {
        detail?: { resid?: string; source?: string; summary?: string; news?: { text?: string }[] };
      };
    };
    expect(cardJson.meta?.detail?.resid).toBe('res-g');
    // 卡片封面要有预览内容：source / summary / news（少一样收端就只剩一个标题）。
    expect(cardJson.meta?.detail?.source).toBe('小明的聊天记录');
    expect(cardJson.meta?.detail?.summary).toBe('查看1条转发消息');
    expect(cardJson.meta?.detail?.news).toEqual([{ text: '小明: 你好' }]);
  });

  it('私聊：长消息用自己 uid 的槽位，卡片走 c2c 路由', async () => {
    const native = forwardNative('res-c');
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    const outcome = await svc.sendForward({
      peerType: 'c2c',
      targetId: '20002',
      nodes: [{ elements: [{ kind: 'text', textContent: 'hi' }] }],
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.uid).toBe('u_friend');
    expect(outcome.scene).toBe('c2c');
    const longReq = decode(SEND_LONG_MSG_REQ, native.calls[0]!.body) as {
      info?: { type?: number; uid?: { uid?: string }; groupUin?: number };
    };
    expect(longReq.info?.type).toBe(1);
    expect(longReq.info?.uid?.uid).toBe('u_me'); // 自己 uid
    expect(longReq.info?.groupUin).toBeUndefined();

    const cardReq = decode(SEND_MESSAGE_REQUEST, native.calls[1]!.body) as {
      routingHead?: { c2c?: { uin?: number } };
    };
    expect(cardReq.routingHead?.c2c?.uin).toBe(20002);
  });

  it('嵌套转发：内层 + 外层各一次长消息上传，卡片用最外层 resId', async () => {
    const calls: PacketCall[] = [];
    let resSeq = 0;
    const native = {
      calls,
      sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
        calls.push({ pid, cmd, body: new Uint8Array(body) });
        if (cmd.includes('SsoSendLongMsg')) {
          resSeq += 1;
          return Buffer.from(encode(SEND_LONG_MSG_RESP, { result: { resId: `res-${resSeq}` } }));
        }
        return Buffer.from(
          encode(SEND_MESSAGE_RESPONSE, { result: 0, groupSequence: 1, timestamp1: 1 }),
        );
      },
      sendOidbPacket: async (): Promise<Buffer> => {
        throw new Error('这条用例不该走 OIDB');
      },
    };
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    const outcome = await svc.sendForward({
      peerType: 'group',
      targetId: '1',
      nodes: [
        {
          elements: [{ kind: 'text', textContent: '外层' }],
          innerForward: [{ elements: [{ kind: 'text', textContent: '内层' }] }],
        },
      ],
    });
    expect(outcome.resId).toBe('res-2'); // 最外层
    expect(outcome.levels).toBe(2);
    expect(calls.filter((c) => c.cmd.includes('SsoSendLongMsg'))).toHaveLength(2);

    // 外层 payload 里应有 MultiMsg + 一条 uuid piggyback。
    const outer = decode(SEND_LONG_MSG_REQ, calls[1]!.body) as { info?: { payload?: Uint8Array } };
    const actions = decode(
      LONG_MSG_RESULT,
      new Uint8Array(gunzipSync(Buffer.from(outer.info!.payload!))),
    ) as { action?: { actionCommand?: string }[] };
    expect(actions.action).toHaveLength(2);
    expect(actions.action![0]!.actionCommand).toBe('MultiMsg');
  });

  it('空 nodes 在联网前就拦下', async () => {
    const native = forwardNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await expect(svc.sendForward({ peerType: 'group', targetId: '1', nodes: [] })).rejects.toThrow(
      /不能为空/,
    );
    expect(native.calls).toHaveLength(0);
  });

  it('私聊含媒体但 uid 缺失：上传前就拦下', async () => {
    const native = forwardNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await expect(
      svc.sendForward({
        peerType: 'c2c',
        targetId: '30003', // fakeSession 里没有这个 uin → uid 解析不到
        nodes: [{ elements: [{ kind: 'image', source: new Uint8Array([1, 2, 3]) }] }],
      }),
    ).rejects.toThrow(/必须带 uid/);
    expect(native.calls).toHaveLength(0);
  });

  it('卡片那一步失败：ok=false 但 resId 仍返回（内容已在服务端）', async () => {
    const calls: PacketCall[] = [];
    const native = {
      calls,
      sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
        calls.push({ pid, cmd, body: new Uint8Array(body) });
        if (cmd.includes('SsoSendLongMsg')) {
          return Buffer.from(encode(SEND_LONG_MSG_RESP, { result: { resId: 'res-x' } }));
        }
        return Buffer.from(
          encode(SEND_MESSAGE_RESPONSE, { result: 79, errMsg: 'rejected', timestamp1: 1 }),
        );
      },
      sendOidbPacket: async (): Promise<Buffer> => {
        throw new Error('这条用例不该走 OIDB');
      },
    };
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    const outcome = await svc.sendForward({
      peerType: 'group',
      targetId: '1',
      nodes: [{ elements: [{ kind: 'text', textContent: 'x' }] }],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.resId).toBe('res-x');
    expect(outcome.hint).toMatch(/卡片没发出去|重发/);
  });
});

// ─────────────────────── Ark 卡片：图文 / 推荐 / 位置 ───────────────────────

/** 位置卡片请求 body 的字段布局（与 protocol 的实现对齐，这里只用于解码断言）。 */
const LOCATION_ARK_REQ = message([
  { name: 'targetUin', tag: 1, type: 'uint64' },
  { name: 'peerType', tag: 2, type: 'uint32' },
  { name: 'address', tag: 3, type: 'string' },
  { name: 'region', tag: 4, type: 'string' },
  { name: 'latitude', tag: 5, type: 'string' },
  { name: 'longitude', tag: 6, type: 'string' },
]);

interface OidbCall {
  pid: number;
  command: number;
  subCommand: number;
  body: Uint8Array;
  isUid: boolean;
}

/** 从解码后的 ELEM 里取出 ark 的 `lightApp.data`，还原成 JSON 字符串。 */
function arkDataOf(elem: unknown): string {
  const data = (elem as { lightApp?: { data?: Uint8Array } }).lightApp?.data;
  if (!data) return '';
  // 首个字节是标志位，之后是 deflate 流（与 protocol 的 deflatePayload / inflate 对应）。
  return inflateSync(Buffer.from(data.subarray(1))).toString('utf8');
}

/** 解出 PbSendMsg 里的元素数组。 */
function elemsOf(body: Uint8Array): unknown[] {
  const decoded = decode(SEND_MESSAGE_REQUEST, body) as {
    messageBody?: { richText?: { elems?: unknown[] } };
  };
  return decoded.messageBody?.richText?.elems ?? [];
}

describe('MessageSendService.sendAiVoice 参数校验（纯函数）', () => {
  it('非数字群号：明确报「只支持群聊 / 群号」', async () => {
    const svc = new MessageSendService(fakeNative() as never, fakeSession(), () => 1);
    await expect(
      svc.sendAiVoice({ groupId: '某群', voiceId: 'lucy-voice-1', text: 'hi' }),
    ).rejects.toThrow(/只支持群聊/);
  });

  it('声线 id 为空 / 合成文字为空：在校验阶段就报错（不进 OIDB）', async () => {
    const svc = new MessageSendService(fakeNative() as never, fakeSession(), () => 1);
    await expect(svc.sendAiVoice({ groupId: '123', voiceId: '  ', text: 'hi' })).rejects.toThrow(
      /声线 id/,
    );
    await expect(svc.sendAiVoice({ groupId: '123', voiceId: 'v', text: '   ' })).rejects.toThrow(
      /合成文字/,
    );
  });
});

describe('Ark 卡片参数校验（纯函数）', () => {
  it('requireArkJson：空 / 非法 JSON 报错，合法 JSON 去掉首尾空白', () => {
    expect(requireArkJson('  {"a":1}  ')).toBe('{"a":1}');
    expect(() => requireArkJson('   ')).toThrow(/不能为空/);
    expect(() => requireArkJson('{oops}')).toThrow(/合法的 JSON/);
  });

  it('decimalCoordinate：非数字 / 越界报错，合法值原样（去空白）返回', () => {
    expect(decimalCoordinate(' 31.763573 ', 'latitude', 90)).toBe('31.763573');
    expect(() => decimalCoordinate('', 'latitude', 90)).toThrow(/十进制度数字符串/);
    expect(() => decimalCoordinate('abc', 'latitude', 90)).toThrow(/十进制度数字符串/);
    expect(() => decimalCoordinate('91', 'latitude', 90)).toThrow(/超出范围/);
    expect(decimalCoordinate('180', 'longitude', 180)).toBe('180');
  });
});

describe('MessageSendService.sendArkCard（离线集成）', () => {
  it('ark JSON 编成 lightApp 元素发到群聊', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 7);
    const ark = JSON.stringify({ app: 'com.tencent.tuwen.lua', view: 'news' });

    const outcome = await svc.sendArkCard({ peerType: 'group', targetId: '123', arkData: ark });

    expect(outcome.ok).toBe(true);
    expect(native.calls).toHaveLength(1);
    expect(native.calls[0]!.cmd).toBe('MessageSvc.PbSendMsg');
    const elems = elemsOf(native.calls[0]!.body);
    expect(elems).toHaveLength(1);
    expect(arkDataOf(elems[0])).toBe(ark);
  });

  it('非法 JSON：一个字节都不发', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await expect(
      svc.sendArkCard({ peerType: 'group', targetId: '1', arkData: 'not json' }),
    ).rejects.toThrow(/合法的 JSON/);
    expect(native.calls).toHaveLength(0);
  });
});

describe('MessageSendService.sendLocationCard（离线集成）', () => {
  it('群聊：走 trpc 位置卡片命令字，peerType=1，六个字段齐全', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 99);

    const outcome = await svc.sendLocationCard({
      peerType: 'group',
      targetId: '2863253201',
      address: ' XX路2号 ',
      region: '四川省成都市武侯区',
      latitude: '30.572815',
      longitude: '104.066801',
    });

    expect(native.calls).toHaveLength(1);
    expect(native.calls[0]!.cmd).toBe(LOCATION_ARK_CMD);
    expect(native.calls[0]!.pid).toBe(99);
    const body = decode(LOCATION_ARK_REQ, native.calls[0]!.body) as Record<string, unknown>;
    expect(Number(body.targetUin)).toBe(2863253201);
    expect(body.peerType).toBe(1);
    expect(body.address).toBe('XX路2号');
    expect(body.region).toBe('四川省成都市武侯区');
    expect(body.latitude).toBe('30.572815');
    expect(body.longitude).toBe('104.066801');

    // 回包解析不出业务结果：必须如实说「无法确认」，不能当成「已送达」。
    expect(outcome.ok).toBe(true);
    expect(outcome.hint).toMatch(/无法从回包确认/);
    expect(outcome.address).toBe('XX路2号');
  });

  it('私聊：peerType=0 也必须上 wire', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await svc.sendLocationCard({
      peerType: 'c2c',
      targetId: '20002',
      address: 'A',
      region: 'B',
      latitude: '1.5',
      longitude: '2.5',
    });
    const body = decode(LOCATION_ARK_REQ, native.calls[0]!.body) as Record<string, unknown>;
    expect(body.peerType).toBe(0);
    expect(body.targetUin).toBeDefined();
  });

  it('地址为空 / 经纬度越界：直接报错，不发包', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    const base = {
      peerType: 'group' as const,
      targetId: '1',
      address: 'A',
      region: 'B',
      latitude: '1',
      longitude: '2',
    };
    await expect(svc.sendLocationCard({ ...base, region: '  ' })).rejects.toThrow(/省市区/);
    await expect(svc.sendLocationCard({ ...base, address: ' ' })).rejects.toThrow(/详细地址/);
    await expect(svc.sendLocationCard({ ...base, latitude: '999' })).rejects.toThrow(/超出范围/);
    expect(native.calls).toHaveLength(0);
  });
});

describe('MessageSendService.sendContactCard（离线集成）', () => {
  /** 记账 native：OIDB 回一张指定 ark 的取卡响应，SSO 回一条成功的 PbSendMsg 回执。 */
  function contactNative(arkJson: string): { oidb: OidbCall[]; sso: PacketCall[]; native: never } {
    const oidb: OidbCall[] = [];
    const sso: PacketCall[] = [];
    const native = {
      sendOidbPacket: async (
        pid: number,
        command: number,
        subCommand: number,
        body: Buffer,
        isUid = false,
      ): Promise<Buffer> => {
        oidb.push({ pid, command, subCommand, body: new Uint8Array(body), isUid });
        // 两条取卡协议的响应字段名不同（好友 ark / 群 arkJson），按命令字给对应的。
        return Buffer.from(
          command === GetBuddyRecommendArk.command
            ? encode(GetBuddyRecommendArk.respSchema, { ark: arkJson })
            : encode(GetGroupRecommendArk.respSchema, { errCode: 0, arkJson }),
        );
      },
      sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
        sso.push({ pid, cmd, body: new Uint8Array(body) });
        return Buffer.from(encode(SEND_MESSAGE_RESPONSE, { result: 0, groupSequence: 5 }));
      },
    };
    return { oidb, sso, native: native as never };
  }

  it('推荐群：先 0x8b7_5 取卡（uin-form），再把卡当 lightApp 元素发出去', async () => {
    const ark = JSON.stringify({ app: 'com.tencent.troopsharecard', view: 'group' });
    const { oidb, sso, native } = contactNative(ark);
    const svc = new MessageSendService(native, fakeSession(), () => 11);

    const outcome = await svc.sendContactCard({
      peerType: 'group',
      targetId: '123',
      kind: 'group',
      contactId: 456789,
    });

    expect(oidb).toHaveLength(1);
    expect(oidb[0]!.command).toBe(0x8b7);
    expect(oidb[0]!.subCommand).toBe(5);
    expect(oidb[0]!.isUid).toBe(true);
    expect(oidb[0]!.pid).toBe(11);

    expect(sso).toHaveLength(1);
    expect(sso[0]!.cmd).toBe('MessageSvc.PbSendMsg');
    const elems = elemsOf(sso[0]!.body);
    expect(arkDataOf(elems[0])).toBe(ark);

    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe('group');
    expect(outcome.contactId).toBe(456789);
    expect(outcome.arkJson).toBe(ark);
    // 回执的 random 是前端对账主键：推荐卡片也必须带上（协议层发送前生成、服务端回显）。
    expect(outcome.random).toBeGreaterThan(0);
    expect(outcome).not.toHaveProperty('messageId');
  });

  it('推荐好友：0x12b6_0（非 uin-form）+ 手机号占位符', async () => {
    const ark = JSON.stringify({ app: 'com.tencent.troopsharecard' });
    const { oidb, sso, native } = contactNative(ark);
    const svc = new MessageSendService(native, fakeSession(), () => 1);

    const outcome = await svc.sendContactCard({
      peerType: 'c2c',
      targetId: 'u_friend',
      kind: 'qq',
      contactId: 20002,
    });

    expect(oidb[0]!.command).toBe(0x12b6);
    expect(oidb[0]!.subCommand).toBe(0);
    expect(oidb[0]!.isUid).toBe(false);
    expect(sso[0]!.cmd).toBe('MessageSvc.PbSendMsg');
    expect(outcome.ok).toBe(true);
    expect(outcome.kind).toBe('qq');
  });

  it('服务端没给卡（空 ark）：抛错，不发元素', async () => {
    const { sso, native } = contactNative('');
    const svc = new MessageSendService(native, fakeSession(), () => 1);
    await expect(
      svc.sendContactCard({ peerType: 'group', targetId: '1', kind: 'group', contactId: 2 }),
    ).rejects.toThrow(/没有生成推荐卡片|空的/);
    expect(sso).toHaveLength(0);
  });
});

/**
 * 商城表情的 `encryptKey` 回填。
 *
 * 真机实测（2026-09-27）：QQ 发商城表情一定带 16 字符密钥；**空密钥会被服务端
 * 挂住不回包**（`reply timeout for request N`，实测三轮都超时），带上就 `result=0`。
 * 这里断言回填真的写进了上 wire 的报文。
 */
describe('MessageSendService：商城表情 encryptKey 回填', () => {
  const MFACE = {
    kind: 'mface',
    marketEmoticonId: 'a32a7d86b4742dc78697883fe9dd68f1',
    emojiPackId: 243630,
    faceName: '[笑对人生]',
  } as const;

  /** 取报文里第一个 marketFace 元素。 */
  function marketFaceOf(body: Uint8Array): Record<string, unknown> {
    const decoded = decode(SEND_MESSAGE_REQUEST, body) as {
      messageBody?: { richText?: { elems?: Record<string, unknown>[] } };
    };
    const elems = decoded.messageBody?.richText?.elems ?? [];
    const found = elems.find((e) => e.marketFace)?.marketFace;
    if (!found) throw new Error('报文里没有 marketFace 元素');
    return found as Record<string, unknown>;
  }

  it('空密钥 → 用包解析器补上（真机密钥，写进报文）', async () => {
    const native = fakeNative();
    const asked: string[] = [];
    const svc = new MessageSendService(
      native as never,
      fakeSession(),
      () => 1,
      async (packId) => {
        asked.push(packId);
        return '145fb68a7df26c50';
      },
    );
    await svc.sendElements({ peerType: 'c2c', targetId: '20002', elements: [MFACE] });

    expect(asked).toEqual(['243630']);
    expect(marketFaceOf(native.calls[0]!.body).encryptKey).toBe('145fb68a7df26c50');
    // previewWidth/Height 与 mediaType 也是抓包对齐的固定值。
    expect(marketFaceOf(native.calls[0]!.body).previewWidth).toBe(200);
    expect(marketFaceOf(native.calls[0]!.body).mediaType).toBe(0);
  });

  it('已带密钥 → 不查解析器，原样发出', async () => {
    const native = fakeNative();
    let calls = 0;
    const svc = new MessageSendService(
      native as never,
      fakeSession(),
      () => 1,
      async () => {
        calls += 1;
        return 'other-key-000000';
      },
    );
    await svc.sendElements({
      peerType: 'c2c',
      targetId: '20002',
      elements: [{ ...MFACE, encryptKey: 'already-key-0000' }],
    });
    expect(calls).toBe(0);
    expect(marketFaceOf(native.calls[0]!.body).encryptKey).toBe('already-key-0000');
  });

  it('同一个包在一条消息里只查一次（两个包查两次）', async () => {
    const native = fakeNative();
    const asked: string[] = [];
    const svc = new MessageSendService(
      native as never,
      fakeSession(),
      () => 1,
      async (packId) => {
        asked.push(packId);
        return '145fb68a7df26c50';
      },
    );
    await svc.sendElements({
      peerType: 'c2c',
      targetId: '20002',
      elements: [
        MFACE,
        { ...MFACE },
        { ...MFACE, emojiPackId: 7, marketEmoticonId: 'b'.repeat(32) },
      ],
    });
    expect(asked).toEqual(['243630', '7']);
    const elems = (
      decode(SEND_MESSAGE_REQUEST, native.calls[0]!.body) as {
        messageBody?: { richText?: { elems?: Record<string, unknown>[] } };
      }
    ).messageBody?.richText?.elems as Record<string, unknown>[];
    for (const elem of elems) {
      expect((elem.marketFace as Record<string, unknown>).encryptKey).toBe('145fb68a7df26c50');
    }
  });

  it('解析失败 → 保持空密钥（不阻塞发送，也不编一个假密钥）', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(
      native as never,
      fakeSession(),
      () => 1,
      async () => {
        throw new Error('CDN 不可达');
      },
    );
    await svc.sendElements({ peerType: 'c2c', targetId: '20002', elements: [MFACE] });
    // 空密钥按 proto3 缺省不上 wire（不是显式空串），与旧行为逐字节一致。
    expect(marketFaceOf(native.calls[0]!.body).encryptKey).toBeUndefined();
  });

  it('没注入解析器 → 字节与旧行为一致（不带密钥）', async () => {
    const native = fakeNative();
    const svc = new MessageSendService(native as never, fakeSession(), () => 1);
    await svc.sendElements({ peerType: 'c2c', targetId: '20002', elements: [MFACE] });
    expect(marketFaceOf(native.calls[0]!.body).encryptKey).toBeUndefined();
  });
});
