/**
 * msg/send-forward 的离线单元测试：
 *   - SsoSendLongMsg 请求编码（黄金字节，手工按 wire format 构造）
 *   - 群聊 / 私聊的 info 形状（type、uid、groupUin）
 *   - 节点 → PushMsgBody（头部、时间、随机 msgId/seq）
 *   - 节点级装扮（含字体两个 id：fontId1 原样 / fontId2 字节交换）
 *   - 嵌套转发 piggyback（内层 actionCommand == 外层卡片 uniseq）
 *   - 错误路径：目标二选一、空节点、私聊含媒体缺 uid（联网之前就拦下）
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  decode,
  encode,
  LONG_MSG_RESULT,
  SEND_LONG_MSG_REQ,
  SEND_LONG_MSG_RESP,
  SSO_SEND_LONG_MSG_CMD,
  PUSH_MSG_BODY,
  SendLongMsg,
  buildForwardNodeBody,
  decodeMessage,
  sendForward,
  swapFontId16,
  type ForwardEncodeContext,
} from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

/** 记账 native：记录每次 sendPacket，按顺序回 resId。 */
function fakeNative(resIds: string[] = ['res-1']) {
  const calls: { pid: number; cmd: string; body: Uint8Array }[] = [];
  let index = 0;
  return {
    calls,
    sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
      calls.push({ pid, cmd, body: new Uint8Array(body) });
      const resId = resIds[index++] ?? `res-${index}`;
      return Buffer.from(encode(SEND_LONG_MSG_RESP, { result: { resId } }));
    },
    sendOidbPacket: async (): Promise<Buffer> => {
      throw new Error('这条用例不该走 OIDB（节点内媒体上传）');
    },
  };
}

/** 解开某次请求的 payload → LongMsgResult 的 action 列表。 */
function actionsOf(body: Uint8Array): Record<string, unknown>[] {
  const req = decode(SEND_LONG_MSG_REQ, body) as {
    info?: { payload?: Uint8Array };
  };
  const payload = req.info?.payload;
  expect(payload).toBeInstanceOf(Uint8Array);
  const longMsg = decode(LONG_MSG_RESULT, new Uint8Array(gunzipSync(Buffer.from(payload!)))) as {
    action?: Record<string, unknown>[];
  };
  return longMsg.action ?? [];
}

describe('SsoSendLongMsg 请求编码', () => {
  it('SendLongMsg.serialize：群聊 type=3 且 uid.uid / groupUin 都是群号', () => {
    const obj = SendLongMsg.serialize({
      groupId: 1234,
      selfUid: 'u_self',
      payload: new Uint8Array([1, 2, 3]),
    });
    expect(obj).toEqual({
      info: { type: 3, uid: { uid: '1234' }, groupUin: 1234, payload: new Uint8Array([1, 2, 3]) },
      settings: { field1: 4, field2: 1, field3: 7, field4: 0 },
    });
  });

  it('SendLongMsg.serialize：私聊 type=1 且 uid.uid 是自己 uid、不带 groupUin', () => {
    const obj = SendLongMsg.serialize({ selfUid: 'u_self', payload: new Uint8Array([9]) });
    expect(obj).toEqual({
      info: { type: 1, uid: { uid: 'u_self' }, payload: new Uint8Array([9]) },
      settings: { field1: 4, field2: 1, field3: 7, field4: 0 },
    });
  });

  it('私有设置的 settings 会被写进请求', () => {
    const obj = SendLongMsg.serialize({
      groupId: 1,
      selfUid: 'u',
      payload: new Uint8Array([0]),
      settings: { field1: 0, field2: 0, field3: 0, field4: 0 },
    });
    expect(obj.settings).toEqual({ field1: 0, field2: 0, field3: 0, field4: 0 });
  });

  it('黄金字节：私聊 info.type=1 + uid.uid + payload + settings{4,1,7}', () => {
    const bytes = encode(
      SEND_LONG_MSG_REQ,
      SendLongMsg.serialize({ selfUid: 'u', payload: new Uint8Array([0xaa, 0xbb]) }),
    );
    expect(Array.from(bytes)).toEqual(
      Array.from(
        // info{ type=1, uid{uid='u'}, payload=aa bb } → tag2 len 11
        // settings{ 4, 1, 7, 0 }：field4=0 是标量默认值，不上 wire。
        hexToBytes('12 0b 08 01 12 03 12 01 75 22 02 aa bb 7a 06 08 04 10 01 18 07'),
      ),
    );
  });

  it('SendLongMsg.deserialize：取 result.resId', () => {
    expect(SendLongMsg.deserialize({ result: { resId: 'abc' } })).toEqual({ resId: 'abc' });
    expect(SendLongMsg.deserialize({ result: {} })).toEqual({ resId: '' });
    expect(SendLongMsg.deserialize({})).toEqual({ resId: '' });
  });
});

describe('节点 → PushMsgBody', () => {
  const baseCtx = (over: Partial<ForwardEncodeContext> = {}): ForwardEncodeContext => ({
    nt: fakeNative() as never,
    pid: 1,
    selfUin: 10001,
    selfUid: 'u_self',
    scene: 'group',
    groupId: 67890,
    ...over,
  });

  it('群聊节点：msgType=82，grp.groupUin + grp.memberName，fromUin 用节点 uin', async () => {
    const body = await buildForwardNodeBody(
      { userUin: 20002, nickname: '小明', elements: [{ kind: 'text', textContent: '你好' }] },
      baseCtx(),
    );
    expect(body.responseHead).toEqual({
      fromUin: 20002,
      fromUid: '',
      grp: { groupUin: 67890, memberName: '小明' },
    });
    const head = body.contentHead as Record<string, unknown>;
    expect(head.msgType).toBe(82);
    expect(head.subType).toBeUndefined();
    expect((body.body as { richText: { elems: unknown[] } }).richText.elems).toEqual([
      { text: { str: '你好' } },
    ]);
  });

  it('私聊节点：msgType=9/subType=4，forward.friendName + toUid=selfUid', async () => {
    const body = await buildForwardNodeBody(
      { userUin: 20002, nickname: '小红', elements: [{ kind: 'text', textContent: 'hi' }] },
      baseCtx({ scene: 'c2c', groupId: undefined }),
    );
    expect(body.responseHead).toEqual({
      fromUin: 20002,
      fromUid: '',
      forward: { friendName: '小红' },
      toUid: 'u_self',
    });
    const head = body.contentHead as Record<string, unknown>;
    expect(head.msgType).toBe(9);
    expect(head.subType).toBe(4);
  });

  it('节点时间 / msgId / msgSeq：给了用给的，没给就随机正数', async () => {
    const withTime = await buildForwardNodeBody(
      {
        userUin: 1,
        elements: [{ kind: 'text', textContent: 'x' }],
        time: 1600000000,
        msgId: 777,
        msgSeq: 888,
      },
      baseCtx(),
    );
    expect(withTime.contentHead).toMatchObject({
      timestamp: 1600000000,
      msgId: 777,
      sequence: 888,
    });

    const random = await buildForwardNodeBody(
      { userUin: 1, elements: [{ kind: 'text', textContent: 'x' }] },
      baseCtx(),
    );
    const head = random.contentHead as Record<string, number>;
    expect(head.msgId).toBeGreaterThan(0);
    expect(head.sequence).toBeGreaterThan(0);
  });

  it('节点缺省 userUin 时用自己 uin，昵称回退成 QQ 号', async () => {
    const body = await buildForwardNodeBody(
      { elements: [{ kind: 'text', textContent: 'x' }] },
      baseCtx(),
    );
    expect(body.responseHead).toMatchObject({
      fromUin: 10001,
      grp: { groupUin: 67890, memberName: '10001' },
    });
  });
});

describe('节点级装扮（含字体两个 id）', () => {
  const ctx: ForwardEncodeContext = {
    nt: fakeNative() as never,
    pid: 1,
    selfUin: 10001,
    selfUid: 'u_self',
    scene: 'group',
    groupId: 1,
  };

  it('swapFontId16 是低 16 位字节序交换，与收侧解码互为逆运算', () => {
    expect(swapFontId16(54981)).toBe(50646);
    expect(swapFontId16(0)).toBe(0);
    // 收侧 decodeMessage 的 fontId2 回退规则能把交换后的值还原成真实 itemId。
    const bytes = encode(PUSH_MSG_BODY, {
      body: { richText: { elems: [{ generalFlags: { font: { fontId2: 50646 } } }] } },
    });
    expect(decodeMessage(bytes).dress.font).toBe(54981);
  });

  it('fontId 写 fontId1 原样、fontId2 写交换后的值', async () => {
    const body = await buildForwardNodeBody(
      {
        userUin: 1,
        elements: [{ kind: 'text', textContent: 'hi' }],
        dress: { bubbleId: 2116371, fontId: 54981, fontId2: 54981, widgetId: 104228 },
      },
      ctx,
    );
    const elems = (body.body as { richText: { elems: Record<string, unknown>[] } }).richText.elems;
    expect(elems[0]).toEqual({
      generalFlags: { widgetId: 104228, font: { fontId1: 54981, fontId2: 50646 } },
    });
    expect(elems[1]).toEqual({ bubble: { id: 2116371 } });
    expect(elems[2]).toEqual({ text: { str: 'hi' } });
  });

  it('只给 fontId2 也能单独出字体（只写 tag 15 槽位）', async () => {
    const body = await buildForwardNodeBody(
      {
        userUin: 1,
        elements: [{ kind: 'text', textContent: 'hi' }],
        dress: { fontId2: 54981 },
      },
      ctx,
    );
    const elems = (body.body as { richText: { elems: Record<string, unknown>[] } }).richText.elems;
    expect(elems).toEqual([
      { generalFlags: { font: { fontId2: 50646 } } },
      { text: { str: 'hi' } },
    ]);
  });

  it('不传 dress 时元素与以前逐字节一致（零回归）', async () => {
    const body = await buildForwardNodeBody(
      { userUin: 1, elements: [{ kind: 'text', textContent: 'hi' }] },
      ctx,
    );
    const elems = (body.body as { richText: { elems: unknown[] } }).richText.elems;
    expect(elems).toEqual([{ text: { str: 'hi' } }]);
  });

  it('非法装扮 id 在打包阶段就报错', async () => {
    await expect(
      buildForwardNodeBody(
        {
          userUin: 1,
          elements: [{ kind: 'text', textContent: 'hi' }],
          dress: { fontId2: -3 },
        },
        ctx,
      ),
    ).rejects.toThrow(/fontId2/);
  });
});

describe('sendForward 全链路（离线）', () => {
  const params = {
    groupId: 67890,
    selfUin: '10001',
    selfUid: 'u_self',
    nodes: [
      {
        userUin: 20002,
        nickname: '小明',
        elements: [{ kind: 'text' as const, textContent: 'hi' }],
      },
    ],
  };

  it('群聊：一次 sendPacket，cmd 正确，payload 解出 MultiMsg action', async () => {
    const nt = fakeNative(['res-group']);
    const result = await sendForward(nt as never, 1, params);
    expect(result.resId).toBe('res-group');
    expect(result.cmd).toBe(SSO_SEND_LONG_MSG_CMD);
    expect(result.scene).toBe('group');
    expect(nt.calls).toHaveLength(1);
    expect(nt.calls[0]!.cmd).toBe(SSO_SEND_LONG_MSG_CMD);

    const req = decode(SEND_LONG_MSG_REQ, nt.calls[0]!.body) as {
      info?: { type?: number; uid?: { uid?: string }; groupUin?: number };
    };
    expect(req.info?.type).toBe(3);
    expect(req.info?.uid?.uid).toBe('67890');
    expect(req.info?.groupUin).toBe(67890);

    const actions = actionsOf(nt.calls[0]!.body);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.actionCommand).toBe('MultiMsg');
  });

  it('私聊：info.type=1、uid.uid=selfUid、不带 groupUin', async () => {
    const nt = fakeNative(['res-c2c']);
    const result = await sendForward(nt as never, 1, {
      userUin: 20002,
      selfUin: '10001',
      selfUid: 'u_self',
      nodes: [{ userUin: 20002, elements: [{ kind: 'text', textContent: 'hi' }] }],
    });
    expect(result.scene).toBe('c2c');
    const req = decode(SEND_LONG_MSG_REQ, nt.calls[0]!.body) as {
      info?: { type?: number; uid?: { uid?: string }; groupUin?: number };
    };
    expect(req.info?.type).toBe(1);
    expect(req.info?.uid?.uid).toBe('u_self');
    expect(req.info?.groupUin).toBeUndefined();
  });

  it('多节点按顺序进 MultiMsg msgBody', async () => {
    const nt = fakeNative(['res-multi']);
    await sendForward(nt as never, 1, {
      ...params,
      nodes: [
        { userUin: 1, nickname: 'A', elements: [{ kind: 'text', textContent: 'one' }] },
        { userUin: 2, nickname: 'B', elements: [{ kind: 'text', textContent: 'two' }] },
      ],
    });
    const main = actionsOf(nt.calls[0]!.body).find((a) => a.actionCommand === 'MultiMsg')!;
    const msgBody = (main.actionData as { msgBody: Record<string, unknown>[] }).msgBody;
    expect(msgBody).toHaveLength(2);
    expect(msgBody[0]!.responseHead).toMatchObject({ fromUin: 1 });
    expect(msgBody[1]!.responseHead).toMatchObject({ fromUin: 2 });
  });

  it('嵌套转发：内层先传、外层卡片 uniseq 与外层 piggyback actionCommand 一致', async () => {
    const nt = fakeNative(['res-inner', 'res-outer']);
    const result = await sendForward(nt as never, 1, {
      ...params,
      nodes: [
        {
          userUin: 1,
          nickname: 'A',
          elements: [{ kind: 'text', textContent: '外层正文' }],
          innerForward: [
            { userUin: 2, nickname: 'B', elements: [{ kind: 'text', textContent: '内层' }] },
          ],
        },
      ],
    });
    expect(result.resId).toBe('res-outer');
    expect(nt.calls).toHaveLength(2); // 内层 + 外层
    expect(result.levels).toHaveLength(2);
    expect(result.levels[0]!.resId).toBe('res-outer'); // 最外层在前
    expect(result.levels[1]!.resId).toBe('res-inner');

    // 外层 payload：MultiMsg（本身） + 一个 uuid piggyback（内层）
    const outerReq = decode(SEND_LONG_MSG_REQ, nt.calls[1]!.body) as {
      info?: { payload?: Uint8Array };
    };
    const outerActions = decode(
      LONG_MSG_RESULT,
      new Uint8Array(gunzipSync(Buffer.from(outerReq.info!.payload!))),
    ) as { action?: Record<string, unknown>[] };
    const list = outerActions.action ?? [];
    expect(list).toHaveLength(2);
    expect(list[0]!.actionCommand).toBe('MultiMsg');
    const piggyback = list[1]!;
    expect(typeof piggyback.actionCommand).toBe('string');
    expect(piggyback.actionCommand).not.toBe('MultiMsg');

    // 外层 MultiMsg 里那个节点被替换成卡片，uniseq 必须等于 piggyback.actionCommand
    const outerBody = (list[0]!.actionData as { msgBody: Record<string, unknown>[] }).msgBody;
    const card = (
      outerBody[0]!.body as { richText: { elems: { lightApp?: { data: Uint8Array } }[] } }
    ).richText.elems[0]!.lightApp!;
    const json = JSON.parse(inflateSync(Buffer.from(card.data).subarray(1)).toString('utf8')) as {
      meta: { detail: { resid: string; uniseq: string } };
    };
    expect(json.meta.detail.resid).toBe('res-inner');
    expect(json.meta.detail.uniseq).toBe(piggyback.actionCommand);

    // 内层 payload 的 MultiMsg 里是内层节点本身
    const innerActions = actionsOf(nt.calls[0]!.body);
    const innerMain = innerActions.find((a) => a.actionCommand === 'MultiMsg')!;
    const innerBody = (innerMain.actionData as { msgBody: Record<string, unknown>[] }).msgBody;
    expect(innerBody).toHaveLength(1);
    const innerText = (innerBody[0]!.body as { richText: { elems: { text?: { str?: string } }[] } })
      .richText.elems[0]!.text;
    expect(innerText?.str).toBe('内层');
  });
});

describe('错误路径（联网之前拦下）', () => {
  const ok = {
    groupId: 1,
    selfUin: '10001',
    selfUid: 'u_self',
    nodes: [{ elements: [{ kind: 'text' as const, textContent: 'x' }] }],
  };

  it('必须且只能指定一个目标', async () => {
    const nt = fakeNative();
    await expect(sendForward(nt as never, 1, { ...ok, groupId: undefined })).rejects.toThrow(
      /groupId 或 userUin/,
    );
    await expect(sendForward(nt as never, 1, { ...ok, userUin: 20002 })).rejects.toThrow(
      /groupId 或 userUin/,
    );
    expect(nt.calls).toHaveLength(0);
  });

  it('空节点数组 / 空元素节点在联网前报错', async () => {
    const nt = fakeNative();
    await expect(sendForward(nt as never, 1, { ...ok, nodes: [] })).rejects.toThrow(/不能为空/);
    await expect(sendForward(nt as never, 1, { ...ok, nodes: [{ elements: [] }] })).rejects.toThrow(
      /至少/,
    );
    expect(nt.calls).toHaveLength(0);
  });

  it('私聊节点含媒体但没有 userUid：上传前就报错', async () => {
    const nt = fakeNative();
    await expect(
      sendForward(nt as never, 1, {
        groupId: undefined,
        userUin: 20002,
        selfUin: '10001',
        selfUid: 'u_self',
        nodes: [
          {
            elements: [{ kind: 'image', source: new Uint8Array([1, 2, 3]) }],
          },
        ],
      }),
    ).rejects.toThrow(/userUid/);
    expect(nt.calls).toHaveLength(0);
  });

  it('selfUid / selfUin 非法在联网前报错', async () => {
    const nt = fakeNative();
    await expect(sendForward(nt as never, 1, { ...ok, selfUid: '  ' })).rejects.toThrow(/selfUid/);
    await expect(sendForward(nt as never, 1, { ...ok, selfUin: 'abc' })).rejects.toThrow(/selfUin/);
    expect(nt.calls).toHaveLength(0);
  });
});
