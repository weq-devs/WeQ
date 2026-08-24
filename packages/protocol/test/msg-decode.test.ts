import { describe, expect, it } from 'vitest';
import { decodeMessage, encode, PUSH_MSG_BODY } from '../src/index';

describe('decodeMessage 简化消息解码', () => {
  it('把 PushMsgBody 映射成 head/sender/session/elements/dress', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      responseHead: { fromUin: 12345, fromUid: 'u_abc', grp: { groupUin: 67890 } },
      contentHead: { msgType: 82, c2cCmd: 1, msgId: 111, sequence: 7, timestamp: 1700000000 },
      body: {
        richText: {
          elems: [
            { generalFlags: { widgetId: 156358, font: { fontId1: 22004, fontId2: 290024 } } },
            { bubble: { id: 2144536 } },
            { text: { str: 'hi' } },
          ],
        },
      },
    });
    const msg = decodeMessage(bytes);
    expect(msg.head).toEqual({
      msgType: 82,
      subType: 0,
      c2cCmd: 1,
      msgId: 111,
      sequence: 7,
      timestamp: 1700000000,
    });
    expect(msg.sender).toEqual({ uin: 12345, uid: 'u_abc' });
    expect(msg.session).toEqual({ uin: 67890, uid: '' });
    expect(msg.elements).toHaveLength(3);
    expect((msg.elements[2] as { text?: { str?: string } }).text?.str).toBe('hi');
    expect(msg.dress).toEqual({ bubbleId: 2144536, fontId1: 22004, fontId2: 290024, widgetId: 156358 });
  });

  it('无装扮时 dress 全 0', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      contentHead: { msgId: 1, sequence: 1, timestamp: 1 },
      body: { richText: { elems: [{ text: { str: 'x' } }] } },
    });
    const msg = decodeMessage(bytes);
    expect(msg.dress).toEqual({ bubbleId: 0, fontId1: 0, fontId2: 0, widgetId: 0 });
  });

  it('c2c 会话取 toUin/toUid', () => {
    const bytes = encode(PUSH_MSG_BODY, {
      responseHead: { fromUin: 1, fromUid: 'u_me', toUin: 2, toUid: 'u_friend' },
    });
    const msg = decodeMessage(bytes);
    expect(msg.session).toEqual({ uin: 2, uid: 'u_friend' });
  });
});
