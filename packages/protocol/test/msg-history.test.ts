/**
 * msg/get-history + msg/dump 的离线单元测试：
 *   - SsoGetGroupMsg / SsoGetC2cMsg 请求编码（黄金字节，手工按 wire format 构造）
 *   - 群聊响应解码 + extractPath 抠第一条消息
 *   - dumpProto 全字段 tag:value 输出
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { dumpProto, extractPath, walkProto, protoToJson } from '../src/msg/dump';
import { ELEM, GetGroupHistory, GetC2cHistory } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

describe('请求编码（黄金字节）', () => {
  it('SsoGetGroupMsg：info{groupUin,start,end} + direction=true', () => {
    const bytes = encode(
      GetGroupHistory.reqSchema,
      GetGroupHistory.serialize({ groupUin: 10001, startSeq: 5, endSeq: 8 }),
    );
    expect(Array.from(bytes)).toEqual(Array.from(hexToBytes('0a 07 08 91 4e 10 05 18 08 10 01')));
  });

  it('SsoGetC2cMsg：friendUid + start/end', () => {
    const bytes = encode(
      GetC2cHistory.reqSchema,
      GetC2cHistory.serialize({ friendUid: 'u_abc', startSeq: 5, endSeq: 8 }),
    );
    expect(Array.from(bytes)).toEqual(Array.from(hexToBytes('12 05 75 5f 61 62 63 18 05 20 08')));
  });
});

// 一条手工构造的 PushMsgBody：
//   responseHead.fromUin=12345, contentHead{msgType=1,sequence=7}, body.richText.elems[0].text.str="hi"
const MESSAGE_HEX = hexToBytes(
  '0a 03 08 b9 60 12 04 08 01 28 07 1a 0a 0a 08 12 06 0a 04 0a 02 68 69',
);

// 群聊响应：body { groupUin=10001, startSequence=5, endSequence=8, messages=[MESSAGE] }
const GROUP_RESPONSE = hexToBytes(
  '1a 20 18 91 4e 20 05 28 08 32 17 0a 03 08 b9 60 12 04 08 01 28 07 1a 0a 0a 08 12 06 0a 04 0a 02 68 69',
);

// 私聊响应：friendUid="u_abc" + messages=[MESSAGE]
const C2C_RESPONSE = hexToBytes(
  '22 05 75 5f 61 62 63 3a 17 0a 03 08 b9 60 12 04 08 01 28 07 1a 0a 0a 08 12 06 0a 04 0a 02 68 69',
);

describe('响应解码', () => {
  it('SsoGetGroupMsg 响应：body.messages 完整解码', () => {
    const decoded = decode(GetGroupHistory.respSchema, GROUP_RESPONSE) as {
      body?: { groupUin?: number; startSequence?: number; endSequence?: number; messages?: unknown[] };
    };
    expect(decoded.body?.groupUin).toBe(10001);
    expect(decoded.body?.startSequence).toBe(5);
    expect(decoded.body?.endSequence).toBe(8);
    expect(decoded.body?.messages).toHaveLength(1);
    const msg = decoded.body!.messages![0] as {
      responseHead?: { fromUin?: number };
      contentHead?: { msgType?: number; sequence?: number };
      body?: { richText?: { elems?: { text?: { str?: string } }[] } };
    };
    expect(msg.responseHead?.fromUin).toBe(12345);
    expect(msg.contentHead?.msgType).toBe(1);
    expect(msg.contentHead?.sequence).toBe(7);
    expect(msg.body?.richText?.elems?.[0]?.text?.str).toBe('hi');
  });

  it('SsoGetC2cMsg 响应：messages 解码 + friendUid', () => {
    const decoded = decode(GetC2cHistory.respSchema, C2C_RESPONSE) as {
      friendUid?: string;
      messages?: unknown[];
    };
    expect(decoded.friendUid).toBe('u_abc');
    expect(decoded.messages).toHaveLength(1);
  });
});

describe('extractPath', () => {
  it('群聊：body(3) -> messages(6)[0] 抠出第一条消息原始字节', () => {
    const first = extractPath(GROUP_RESPONSE, [{ tag: 3 }, { tag: 6, index: 0 }]);
    expect(first).not.toBeNull();
    expect(Array.from(first!)).toEqual(Array.from(MESSAGE_HEX));
  });

  it('私聊：messages(7)[0] 抠出第一条消息原始字节', () => {
    const first = extractPath(C2C_RESPONSE, [{ tag: 7, index: 0 }]);
    expect(first).not.toBeNull();
    expect(Array.from(first!)).toEqual(Array.from(MESSAGE_HEX));
  });

  it('越界 index 返回 null', () => {
    expect(extractPath(GROUP_RESPONSE, [{ tag: 3 }, { tag: 6, index: 5 }])).toBeNull();
  });
});

describe('dumpProto 全字段 tag:value', () => {
  it('递归展开嵌套 message / string / varint', () => {
    const dump = dumpProto(MESSAGE_HEX);
    expect(dump).toContain('varint=12345');
    expect(dump).toContain('varint=7');
    expect(dump).toContain('string="hi"');
  });

  it('walkProto 对重复字段编号 [index]', () => {
    // body(3) -> richText(1) -> elems(2) 两个元素：text("hi") + face(index=1)
    const two = hexToBytes('1a 0e 0a 0c 12 06 0a 04 0a 02 68 69 12 02 10 01');
    const entries = walkProto(two);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('3.1.2');
    expect(paths).toContain('3.1.2[1]');
  });
});

describe('protoToJson 简洁 JSON 树', () => {
  it('字段号 key + 递归展开 + 叶子为裸值（数字/字符串）', () => {
    const tree = protoToJson(MESSAGE_HEX);
    // 顶层: responseHead(1) / contentHead(2) / body(3)
    expect(Object.keys(tree)).toEqual(['1', '2', '3']);
    const head = tree['2'] as Record<string, unknown>;
    expect(head['1']).toBe(1); // msgType
    expect(head['5']).toBe(7); // sequence
    // body(3) -> richText(1) -> elems(2) -> text(1) -> str(1)
    const body = tree['3'] as Record<string, unknown>;
    const richText = body['1'] as Record<string, unknown>;
    const elem = richText['2'] as Record<string, unknown>;
    const text = elem['1'] as Record<string, unknown>;
    expect(text['1']).toBe('hi');
  });

  it('重复字段收敛为数组（保持顺序）', () => {
    const two = hexToBytes('1a 0e 0a 0c 12 06 0a 04 0a 02 68 69 12 02 10 01');
    const tree = protoToJson(two);
    const body = tree['3'] as Record<string, unknown>;
    const richText = body['1'] as Record<string, unknown>;
    const elems = richText['2'];
    expect(Array.isArray(elems)).toBe(true);
    expect((elems as unknown[]).length).toBe(2);
  });
});

describe('装扮三大 id schema', () => {
  it('generalFlags.widgetId / font.fontId2 / elem.bubble.id 编解码', () => {
    const obj = {
      generalFlags: { widgetId: 156358, font: { fontId1: 22004, fontId2: 290024 } },
      bubble: { id: 2144536 },
    };
    const decoded = decode(ELEM, encode(ELEM, obj)) as {
      generalFlags?: { widgetId?: number; font?: { fontId1?: number; fontId2?: number } };
      bubble?: { id?: number };
    };
    expect(decoded.generalFlags?.widgetId).toBe(156358); // 挂件 id
    expect(decoded.generalFlags?.font?.fontId1).toBe(22004); // 字体 id_1
    expect(decoded.generalFlags?.font?.fontId2).toBe(290024); // 字体 id_2
    expect(decoded.bubble?.id).toBe(2144536); // 气泡 id
  });
});
