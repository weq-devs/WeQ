/**
 * 发消息（MessageSvc.PbSendMsg）离线单测：请求黄金字节 + 元素打包 + 自解码往返 +
 * 响应解析 + 校验失败。
 *
 * 黄金字节按 SnowLuma `proto-defs/action.ts` + core `apis/message.ts` 的字段布局
 * 手工构建（与仓库其它 wire 测试同一套路），保证改字段/改顺序会立刻报红：
 *   群聊纯文本 = routingHead.grp(1→2) + contentHead.type(2→1) + messageBody(3)
 *              + random(5)，0 值按 proto3 缺省不上 wire。
 */

import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildSendElems,
  buildSendRequest,
  decode,
  decodeMessage,
  ELEM,
  encode,
  isSendOk,
  MARKDOWN_COMMON_PB,
  MARKET_FACE_PB_RESERVE,
  EMOJI_BOUNCE_EXTRA,
  POKE_EXTRA,
  PUSH_MSG_BODY,
  parseSendResponse,
  QFACE_EXTRA,
  QSMALL_FACE_EXTRA,
  SEND_MESSAGE_REQUEST,
  SEND_MESSAGE_RESPONSE,
  SEND_MSG_CMD,
  sendMessage,
  TEXT_PB_RESERVE,
} from '../src/index';
import type { SendElement } from '../src/index';

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 元素 → Elem proto 对象 → bytes → 再解回来（顺带验证 schema 字段覆盖完整）。 */
function roundTrip(
  element: SendElement,
  scene?: 'group' | 'c2c' | 'group-temp',
): Record<string, unknown> {
  const [elem] = buildSendElems([element], scene ? { scene } : {});
  return decode(ELEM, encode(ELEM, elem!)) as Record<string, unknown>;
}

/** 解压 xml / ark / forward 的载荷（0x01 头 + zlib，与 decode 的 inflate 对应）。 */
function inflatePayload(data: Uint8Array): string {
  return inflateSync(Buffer.from(data.subarray(1))).toString('utf8');
}

/** 假的 native：记录发出去的命令/字节，回一段预置响应。 */
function fakeNative(responseBytes: Uint8Array) {
  const calls: { pid: number; cmd: string; body: Uint8Array }[] = [];
  return {
    calls,
    nt: {
      sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
        calls.push({ pid, cmd, body: new Uint8Array(body) });
        return Buffer.from(responseBytes);
      },
    },
  };
}

const TEXT: SendElement = { kind: 'text', textContent: 'hi' };

describe('buildSendRequest 请求拼装', () => {
  it('群聊纯文本 = 黄金字节（0 值不上 wire）', () => {
    const built = buildSendRequest({
      groupId: 1234,
      elements: [{ kind: 'text', textContent: 'hi' }],
      random: 1,
    });
    expect(built.scene).toBe('group');
    expect(hexOf(built.bytes)).toBe(
      // routingHead.grp.groupCode = 1234
      '0a05120308d209' +
        // contentHead.type = 1
        '12020801' +
        // messageBody.richText.elems[0].text.str = "hi"
        '1a0a0a0812060a040a026869' +
        // random = 1
        '2801',
    );
  });

  it('私聊带上 uid / c2cCmd / ctrl.msgFlag，@ 走 pbReserve', () => {
    const built = buildSendRequest({
      userUin: 10001,
      userUid: 'u_test',
      elements: [
        { kind: 'at', atTargetUin: 20002, atTargetUid: 'u_x' },
        { kind: 'face', faceId: 14 },
      ],
      random: 42,
      clientSequence: 7,
      msgFlag: 1700000000,
    });
    const req = decode(SEND_MESSAGE_REQUEST, built.bytes) as Record<string, unknown>;
    expect(req.routingHead).toEqual({ c2c: { uin: 10001, uid: 'u_test' } });
    expect(req.contentHead).toEqual({ type: 1, c2cCmd: 11 });
    expect(req.clientSequence).toBe(7);
    expect(req.random).toBe(42);
    expect(req.ctrl).toEqual({ msgFlag: 1700000000 });

    const elems = (req.messageBody as { richText: { elems: Record<string, unknown>[] } }).richText
      .elems;
    const at = elems[0]!.text as { str: string; pbReserve: Uint8Array };
    expect(at.str).toBe('@20002 ');
    // 收侧 TEXT_PB_RESERVE 就是发送侧的 MentionExtra：3=type、4=uin、9=uid。
    expect(decode(TEXT_PB_RESERVE, at.pbReserve)).toEqual({
      subType: 2,
      fromUin: 20002,
      atTargetUid: 'u_x',
    });
    expect((elems[1]!.face as { index: number }).index).toBe(14);
  });

  it('@全体成员：type=1 + uid=all + 固定文案', () => {
    const [elem] = buildSendElems([{ kind: 'at', all: true }]);
    const text = elem!.text as { str: string; pbReserve: Uint8Array };
    expect(text.str).toBe('@全体成员 ');
    expect(decode(TEXT_PB_RESERVE, text.pbReserve)).toEqual({ subType: 1, atTargetUid: 'all' });
  });

  it('群临时会话走 grpTmp + c2cCmd', () => {
    const built = buildSendRequest({
      groupTemp: { groupUin: 555, toUid: 'u_t' },
      elements: [TEXT],
      random: 3,
      clientSequence: 9,
      msgFlag: 1700000000,
    });
    const req = decode(SEND_MESSAGE_REQUEST, built.bytes) as Record<string, unknown>;
    expect(built.scene).toBe('group-temp');
    // uint64 解出来是 bigint（保精度）。
    expect(req.routingHead).toEqual({ grpTmp: { groupUin: 555n, toUid: 'u_t' } });
    expect(req.contentHead).toEqual({ type: 1, c2cCmd: 11 });
    expect(req.ctrl).toEqual({ msgFlag: 1700000000 });
    // 群聊不写 ctrl；私聊/临时会话才写。
    expect(buildSendRequest({ groupId: 1, elements: [TEXT] }).request.ctrl).toBeUndefined();
  });

  it('random 缺省非 0，私聊 clientSequence 缺省自增', () => {
    const a = buildSendRequest({ userUin: 2, elements: [TEXT] });
    const b = buildSendRequest({ userUin: 2, elements: [TEXT] });
    expect(a.random).toBeGreaterThan(0);
    expect(a.clientSequence).toBeGreaterThan(0);
    expect(b.clientSequence).toBe(a.clientSequence + 1);
    // 群聊的 clientSequence 固定 0（不上 wire）。
    expect(buildSendRequest({ groupId: 1, elements: [TEXT] }).clientSequence).toBe(0);
  });
});

describe('元素打包', () => {
  it('发出去的元素能被自家 decoder 解回同一份元素', () => {
    const built = buildSendRequest({
      groupId: 999,
      elements: [
        { kind: 'text', textContent: 'hi' },
        { kind: 'at', atTargetUin: 20002, atTargetUid: 'u_x' },
        { kind: 'face', faceId: 14 },
      ],
      random: 1,
    });
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgType: 2, sequence: 1, timestamp: 1 },
      body: { richText: { elems: built.elems } },
    });
    expect(decodeMessage(bytes).elements).toEqual([
      { kind: 'text', textContent: 'hi' },
      { kind: 'at', textContent: '@20002 ', atTargetUid: 'u_x' },
      { kind: 'face', faceId: 14, subType: 1 },
    ]);
  });

  it('face 三种 wire 形态', () => {
    // 经典小黄脸：老 FaceElem。
    expect(roundTrip({ kind: 'face', faceId: 14 })).toEqual({ face: { index: 14 } });

    // 小黄脸（新结构）：commonElem 33。
    const small = roundTrip({ kind: 'face', faceId: 5, smallFace: true });
    const smallCommon = small.commonElem as {
      serviceType: number;
      pbElem: Uint8Array;
      businessType: number;
    };
    expect(smallCommon.serviceType).toBe(33);
    expect(smallCommon.businessType).toBe(1);
    expect(decode(QSMALL_FACE_EXTRA, smallCommon.pbElem)).toEqual({ faceId: 5 });

    // 动态/超级表情：commonElem 37。
    const superSticker = roundTrip({
      kind: 'face',
      faceId: 260,
      superSticker: { packId: '1', stickerId: '260_1', stickerType: 1 },
    });
    const superCommon = superSticker.commonElem as { serviceType: number; pbElem: Uint8Array };
    expect(superCommon.serviceType).toBe(37);
    expect(decode(QFACE_EXTRA, superCommon.pbElem)).toEqual({
      packId: '1',
      stickerId: '260_1',
      qsid: 260,
      sourceType: 1,
      stickerType: 1,
      randomType: 1,
    });
  });

  it('mface：常量槽位 + GUID 两种入参等价', () => {
    const guidHex = 'aabbccddeeff00112233445566778899';
    const fromHex = roundTrip({
      kind: 'mface',
      marketEmoticonId: guidHex,
      emojiPackId: 5,
      encryptKey: '0',
      faceName: '[微笑]',
    });
    const marketFace = fromHex.marketFace as Record<string, unknown>;
    expect(marketFace.faceName).toBe('[微笑]');
    expect(marketFace.itemType).toBe(6);
    expect(marketFace.faceInfo).toBe(1);
    expect(marketFace.subType).toBe(3);
    expect(marketFace.emojiPackId).toBe(5);
    expect(marketFace.encryptKey).toBe('0');
    expect(marketFace.previewWidth).toBe(300);
    expect(marketFace.previewHeight).toBe(300);
    expect(hexOf(marketFace.marketEmoticonId as Uint8Array)).toBe(guidHex);
    expect(decode(MARKET_FACE_PB_RESERVE, marketFace.pbReserve as Uint8Array)).toEqual({
      field8: 1,
    });

    const fromBytes = roundTrip({
      kind: 'mface',
      marketEmoticonId: new Uint8Array(16).fill(0xab),
      emojiPackId: 0,
    });
    expect(
      hexOf((fromBytes.marketFace as Record<string, unknown>).marketEmoticonId as Uint8Array),
    ).toBe('ab'.repeat(16));
  });

  it('reply：origSeqs + 发送者/时间 + 嵌套元素 bytes', () => {
    const reply = roundTrip({
      kind: 'reply',
      origMsgSeq: 5,
      origSenderUin: 12345,
      origMsgTime: 1700000000,
      origElements: [{ kind: 'text', textContent: '被引用' }],
    });
    const src = reply.replyElement as Record<string, unknown>;
    expect(src.origMsgSeq).toEqual([5]);
    expect(src.origSenderUin).toBe(12345n);
    expect(src.origMsgTime).toBe(1700000000);
    const nested = src.origElementsRaw as Uint8Array[];
    expect(nested).toHaveLength(1);
    expect(decode(ELEM, nested[0]!)).toEqual({ text: { str: '被引用' } });
  });

  it('xml：serviceId 缺省/0 都按 35，载荷可解压回原文', () => {
    const xml = '<msg serviceID="35"><item/></msg>';
    const plain = roundTrip({ kind: 'xml', xmlContent: xml }).richMsg as {
      serviceId: number;
      template1: Uint8Array;
    };
    expect(plain.serviceId).toBe(35);
    expect(inflatePayload(plain.template1)).toBe(xml);
    const zero = roundTrip({ kind: 'xml', xmlContent: xml, subType: 0 }).richMsg as {
      serviceId: number;
    };
    expect(zero.serviceId).toBe(35);
    const custom = roundTrip({ kind: 'xml', xmlContent: xml, subType: 51 }).richMsg as {
      serviceId: number;
    };
    expect(custom.serviceId).toBe(51);
  });

  it('ark：lightApp.data 解压回 JSON', () => {
    const json = JSON.stringify({ app: 'com.tencent.test', prompt: '你好' });
    const lightApp = roundTrip({ kind: 'ark', arkData: json }).lightApp as { data: Uint8Array };
    expect(inflatePayload(lightApp.data)).toBe(json);
  });

  it('forward：com.tencent.multimsg 卡片字段', () => {
    const lightApp = roundTrip({
      kind: 'forward',
      resId: 'res-1',
      forwardUuid: 'uuid-1',
      forwardSource: '源',
      forwardSummary: '摘要',
      forwardPrompt: '提示',
      forwardNews: [{ text: 'a' }, { text: 'b' }],
    }).lightApp as { data: Uint8Array };
    const card = JSON.parse(inflatePayload(lightApp.data)) as Record<string, unknown>;
    expect(card.app).toBe('com.tencent.multimsg');
    expect(card.desc).toBe('提示');
    expect(card.ver).toBe('0.0.0.5');
    expect(JSON.parse(card.extra as string)).toEqual({ filename: 'uuid-1', tsum: 2 });
    expect(card.meta).toEqual({
      detail: {
        news: [{ text: 'a' }, { text: 'b' }],
        resid: 'res-1',
        source: '源',
        summary: '摘要',
        uniseq: 'uuid-1',
      },
    });

    // 缺省文案 + tsum 兜底 + uniseq 自动生成。
    const fallback = JSON.parse(
      inflatePayload(
        (roundTrip({ kind: 'forward', resId: 'r2' }).lightApp as { data: Uint8Array }).data,
      ),
    ) as Record<string, unknown>;
    expect(fallback.desc).toBe('[聊天记录]');
    const detail = (fallback.meta as { detail: Record<string, unknown> }).detail;
    expect(detail.source).toBe('聊天记录');
    expect(detail.summary).toBe('查看转发消息');
    expect(JSON.parse(fallback.extra as string)).toEqual({ filename: detail.uniseq, tsum: 1 });
  });

  it('markdown / poke 走 commonElem', () => {
    const markdown = roundTrip({
      kind: 'markdown',
      markdownContent: '# 标题',
      markdownTextSummary: '标题',
    }).commonElem as { serviceType: number; pbElem: Uint8Array; businessType: number };
    expect(markdown.serviceType).toBe(45);
    expect(markdown.businessType).toBe(1);
    expect(decode(MARKDOWN_COMMON_PB, markdown.pbElem)).toEqual({
      markdownContent: '# 标题',
      markdownTextSummary: '标题',
    });

    const poke = roundTrip({ kind: 'poke', subType: 1 }, 'c2c').commonElem as {
      serviceType: number;
      pbElem: Uint8Array;
      businessType: number;
    };
    expect(poke.serviceType).toBe(2);
    expect(poke.businessType).toBe(1);
    expect(decode(POKE_EXTRA, poke.pbElem)).toEqual({ type: 1 });
  });

  it('raw 原样透传（给媒体等未适配类型当逃生舱）', () => {
    const elem = {
      commonElem: { serviceType: 48, pbElem: new Uint8Array([1, 2]), businessType: 20 },
    };
    expect(buildSendElems([{ kind: 'raw', elem }])).toEqual([elem]);
  });

  it('表情弹射：字节与真机抓包逐字节一致（faceId 182 / 数量 10 / 笑哭）', () => {
    const [elem] = buildSendElems([{ kind: 'emojiBounce', faceId: 182, count: 10, name: '笑哭' }]);
    // 真机原包里那段 ELEM（含 tag 53 的 key + 长度前缀）原样拷来。
    const real =
      'aa032708171221080d100a1a06e7ac91e593ad321308b6011206e7ac91e593ad1a06e7ac91e593ad180d';
    expect(hexOf(encode(ELEM, elem!))).toBe(real);

    // 字段含义也钉住：serviceType=23、businessType=13、pbElem 里 count=10 / faceId=182。
    const common = elem!.commonElem as {
      serviceType: number;
      businessType: number;
      pbElem: Uint8Array;
    };
    expect(common.serviceType).toBe(23);
    expect(common.businessType).toBe(13);
    expect(decode(EMOJI_BOUNCE_EXTRA, common.pbElem)).toEqual({
      field1: 13,
      count: 10,
      name: '笑哭',
      detail: { faceId: 182, name: '笑哭', name2: '笑哭' },
    });
  });

  it('表情弹射：count 缺省 1、name 可省（服务端按 faceId 渲染）', () => {
    const [elem] = buildSendElems([{ kind: 'emojiBounce', faceId: 183 }]);
    const common = elem!.commonElem as { pbElem: Uint8Array };
    expect(decode(EMOJI_BOUNCE_EXTRA, common.pbElem)).toEqual({
      field1: 13,
      count: 1,
      detail: { faceId: 183 },
    });
  });

  it('表情弹射：非法 faceId 报错', () => {
    expect(() => buildSendElems([{ kind: 'emojiBounce', faceId: -1 }])).toThrow(/faceId/);
    expect(() => buildSendElems([{ kind: 'emojiBounce', faceId: 182, count: -1 }])).toThrow(
      /count/,
    );
  });
});

describe('发消息带装扮（dress）—— 服务端不收，仅保留打包行为', () => {
  // ⚠️ 真机实测（2026-09-25）：服务端不采信客户端自报的装扮 —— 请求 result=0，
  // 但落库的 40801 里 bubbleId/fontId/widgetId 全 0；逐字节重放真机那段
  // generalFlags 结果一样。所以下面这些用例只钉「本地打包成什么字节」，
  // **不代表收端会看到这些装扮**。详见 send-elements.ts 的 SendDress。
  //
  // 真机抓包里的装扮三件套：气泡 2116371 / 字体 54981 / 挂件 104228。
  // 字体在真机包里写的是 fontId2(tag15)=116182（字节交换过的形态），本实现
  // 统一不转、只往 fontId1(tag56) 原样写。
  const DRESS = { bubbleId: 2116371, fontId: 54981, widgetId: 104228 };

  it('装扮 elems 前置，且字体原样写 fontId1（不做字节交换）', () => {
    const elems = buildSendElems([TEXT], { dress: DRESS });
    // 顺序：generalFlags（挂件+字体）→ bubble → 正文，与真机一致。
    expect(elems).toHaveLength(3);
    expect(elems[0]).toEqual({
      generalFlags: { widgetId: 104228, font: { fontId1: 54981 } },
    });
    expect(elems[1]).toEqual({ bubble: { id: 2116371 } });
    expect(elems[2]).toEqual({ text: { str: 'hi' } });

    // 编解码往返后仍然原样，不经任何字节交换。
    const decoded = decode(ELEM, encode(ELEM, elems[0]!)) as {
      generalFlags?: { widgetId?: number; font?: { fontId1?: number; fontId2?: number } };
    };
    expect(decoded.generalFlags?.widgetId).toBe(104228);
    expect(decoded.generalFlags?.font?.fontId1).toBe(54981);
    expect(decoded.generalFlags?.font?.fontId2).toBeUndefined();
  });

  it('只给部分装扮时按需产出：单挂件／单字体／单气泡', () => {
    expect(buildSendElems([TEXT], { dress: { widgetId: 104228 } })).toEqual([
      { generalFlags: { widgetId: 104228 } },
      { text: { str: 'hi' } },
    ]);
    expect(buildSendElems([TEXT], { dress: { fontId: 54981 } })).toEqual([
      { generalFlags: { font: { fontId1: 54981 } } },
      { text: { str: 'hi' } },
    ]);
    expect(buildSendElems([TEXT], { dress: { bubbleId: 2116371 } })).toEqual([
      { bubble: { id: 2116371 } },
      { text: { str: 'hi' } },
    ]);
  });

  it('不传 dress / 传全 0 时字节与以前完全一致（零回归）', () => {
    const before = buildSendRequest({ groupId: 1234, elements: [TEXT], random: 1 });
    const zeros = buildSendRequest({
      groupId: 1234,
      elements: [TEXT],
      random: 1,
      dress: { bubbleId: 0, fontId: 0, widgetId: 0 },
    });
    expect(hexOf(zeros.bytes)).toBe(hexOf(before.bytes));
  });

  it('装扮进请求体，且能被收侧 decodeMessage 解析成同一份 dress', () => {
    const built = buildSendRequest({
      groupId: 999,
      elements: [TEXT],
      random: 1,
      dress: DRESS,
    });
    const req = decode(SEND_MESSAGE_REQUEST, built.bytes) as {
      messageBody: { richText: { elems: Record<string, unknown>[] } };
    };
    // 发侧是 Request，收侧是 PushMsgBody —— 把 elems 搬到收侧的 body 里解一遍，
    // 确认两边的装扮 schema 真的对得上（而不是只是自己 encode 自己 decode）。
    const asPush = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: { richText: { elems: req.messageBody.richText.elems } },
    });
    expect(decodeMessage(asPush).dress).toEqual({
      bubble: 2116371,
      font: 54981,
      widget: 104228,
    });
  });

  it('非法装扮 id 在打包任何元素之前就报错', () => {
    expect(() => buildSendElems([TEXT], { dress: { bubbleId: -1 } })).toThrow(/bubbleId/);
    expect(() => buildSendElems([TEXT], { dress: { fontId: 1.5 } })).toThrow(/fontId/);
    expect(() => buildSendElems([TEXT], { dress: { widgetId: Number.NaN } })).toThrow(/widgetId/);
  });
});

describe('sendMessage / 响应解析', () => {
  it('发群消息：命令字 + 请求字节 + 回执', async () => {
    const responseBytes = encode(SEND_MESSAGE_RESPONSE, {
      result: 0,
      timestamp1: 1700000001,
      groupSequence: 777,
    });
    const { calls, nt } = fakeNative(responseBytes);
    const receipt = await sendMessage(nt, 4242, {
      groupId: 1234,
      elements: [TEXT],
      random: 99,
      clientSequence: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pid).toBe(4242);
    expect(calls[0]!.cmd).toBe(SEND_MSG_CMD);
    const sent = decode(SEND_MESSAGE_REQUEST, calls[0]!.body) as Record<string, unknown>;
    expect(sent.routingHead).toEqual({ grp: { groupCode: 1234n } });
    expect(sent.random).toBe(99);

    expect(receipt.ok).toBe(true);
    expect(isSendOk(receipt)).toBe(true);
    expect(receipt.scene).toBe('group');
    expect(receipt.groupSequence).toBe(777);
    expect(receipt.privateSequence).toBe(0);
    expect(receipt.timestamp).toBe(1700000001);
    expect(receipt.messageId).toBe(99);
    expect(receipt.errMsg).toBe('');
    expect(receipt.responseBytes).toEqual(responseBytes);
  });

  it('私聊回执取 privateSequence，messageId 回退到 seq', async () => {
    const responseBytes = encode(SEND_MESSAGE_RESPONSE, {
      result: 0,
      timestamp1: 1700000002,
      privateSequence: 31,
    });
    const { nt } = fakeNative(responseBytes);
    const receipt = await sendMessage(nt, 1, {
      userUin: 2,
      elements: [TEXT],
      random: 0,
      clientSequence: 5,
      msgFlag: 1700000000,
    });
    expect(receipt.scene).toBe('c2c');
    expect(receipt.privateSequence).toBe(31);
    expect(receipt.messageId).toBe(31);
  });

  it('服务端拒绝 / 空响应都不静默', async () => {
    const rejected = fakeNative(
      encode(SEND_MESSAGE_RESPONSE, { result: 79, errMsg: 'invalid msg' }),
    );
    const r1 = await sendMessage(rejected.nt, 1, { groupId: 1, elements: [TEXT], random: 1 });
    expect(r1.ok).toBe(false);
    expect(r1.result).toBe(79);
    expect(r1.errMsg).toBe('invalid msg');

    const empty = fakeNative(new Uint8Array(0));
    const r2 = await sendMessage(empty.nt, 1, { groupId: 1, elements: [TEXT], random: 1 });
    expect(r2.ok).toBe(false);
    expect(r2.result).toBe(0);
    expect(r2.errMsg).toBe('服务端未返回响应体');
  });

  it('parseSendResponse 缺字段按 0 处理', () => {
    expect(parseSendResponse(new Uint8Array(0))).toEqual({
      result: 0,
      errMsg: '',
      timestamp1: 0,
      groupSequence: 0,
      privateSequence: 0,
      field10: 0,
      timestamp2: 0,
    });
  });
});

describe('校验失败', () => {
  const text = (content: string): SendElement => ({ kind: 'text', textContent: content });

  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['没有目标', { elements: [text('x')], random: 1 }, /必须且只能指定一个目标/],
    [
      '多个目标',
      { groupId: 1, userUin: 2, elements: [text('x')], random: 1 },
      /必须且只能指定一个目标/,
    ],
    ['空消息', { groupId: 1, elements: [], random: 1 }, /消息不能为空/],
    ['空文本', { groupId: 1, elements: [text('')], random: 1 }, /缺少 textContent/],
    ['@ 没有目标', { groupId: 1, elements: [{ kind: 'at' }], random: 1 }, /需要 atTargetUin/],
    [
      '群聊发抖动',
      { groupId: 1, elements: [{ kind: 'poke', subType: 1 }], random: 1 },
      /只能在直接私聊里发送/,
    ],
    [
      '抖动不独占',
      { userUin: 2, elements: [{ kind: 'poke', subType: 1 }, text('x')], random: 1 },
      /必须独占一条消息/,
    ],
    [
      'mface GUID 非 hex',
      {
        userUin: 2,
        elements: [{ kind: 'mface', marketEmoticonId: 'zz', emojiPackId: 1 }],
        random: 1,
      },
      /32 位 hex/,
    ],
    [
      'mface GUID 长度不对',
      {
        userUin: 2,
        elements: [{ kind: 'mface', marketEmoticonId: new Uint8Array(8), emojiPackId: 1 }],
        random: 1,
      },
      /16 字节/,
    ],
    [
      '超级表情缺 packId',
      {
        userUin: 2,
        elements: [{ kind: 'face', faceId: 1, superSticker: { packId: '', stickerId: 'x' } }],
        random: 1,
      },
      /缺少 superSticker.packId/,
    ],
    [
      '回复 seq 非正',
      { userUin: 2, elements: [{ kind: 'reply', origMsgSeq: 0 }], random: 1 },
      /必须是正整数/,
    ],
    ['groupId 非法', { groupId: 0, elements: [text('x')], random: 1 }, /groupId 非法/],
    ['random 非法', { groupId: 1, elements: [text('x')], random: -1 }, /random 非法/],
    [
      'clientSequence 非法',
      { groupId: 1, elements: [text('x')], clientSequence: -1 },
      /clientSequence 非法/,
    ],
    [
      'forward 缺 resId',
      { groupId: 1, elements: [{ kind: 'forward', resId: '' }], random: 1 },
      /缺少 resId/,
    ],
    [
      'raw 不是对象',
      { groupId: 1, elements: [{ kind: 'raw', elem: null }], random: 1 },
      /raw 元素/,
    ],
    ['媒体元素走同步打包', { groupId: 1, elements: [{ kind: 'video' }], random: 1 }, /需要先上传/],
    ['未知类型', { groupId: 1, elements: [{ kind: 'nope' }], random: 1 }, /不支持发送的元素类型/],
  ];

  it.each(cases)('%s', (_label, params, pattern) => {
    expect(() => buildSendRequest(params as never)).toThrow(pattern);
  });

  it('群临时会话 toUid 必填', () => {
    expect(() =>
      buildSendRequest({
        groupTemp: { groupUin: 5, toUid: ' ' },
        elements: [text('x')],
        random: 1,
      }),
    ).toThrow(/toUid 不能为空/);
  });
});
