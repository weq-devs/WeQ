import { describe, expect, it } from 'vitest';
import { qqEssenceTarget } from '../src/renderer/src/lib/qqEssenceTarget';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const demo = createTemplateDemoData();
const group = {
  ...demo.conversations.find((conversation) => conversation.type === 'group')!,
  id: '12345',
};
const message = { ...demo.messages[0]!, conversationId: group.id, msgSeq: '100', msgRandom: '77' };

describe('精华写操作的消息身份', () => {
  it('仅使用同一群的原序号与 random，不用消息 id 推算', () => {
    expect(qqEssenceTarget(group, message)).toEqual({ groupId: 12345, sequence: 100, random: 77 });
    expect(
      qqEssenceTarget(group, { ...message, id: 'unrelated-snowflake', msgRandom: '0' }),
    ).toEqual({ groupId: 12345, sequence: 100, random: 0 });
  });
  it('缺少 random/seq、跨会话及私聊不能构造请求', () => {
    for (const changed of [
      { msgRandom: undefined },
      { msgRandom: '' },
      { msgSeq: undefined },
      { conversationId: '54321' },
    ])
      expect(qqEssenceTarget(group, { ...message, ...changed })).toBeNull();
    const direct = demo.conversations.find((conversation) => conversation.type === 'direct')!;
    expect(qqEssenceTarget(direct, { ...message, conversationId: direct.id })).toBeNull();
  });
  it('拒绝越界、负数与小数，不截断后发给其他消息', () => {
    for (const value of ['-1', '1.5', '4294967296', '9007199254740993', 'NaN']) {
      expect(qqEssenceTarget(group, { ...message, msgSeq: value })).toBeNull();
      expect(qqEssenceTarget(group, { ...message, msgRandom: value })).toBeNull();
    }
  });
  it('发送中、失败及疑似静默拒收的乐观消息不可设精华', () => {
    expect(qqEssenceTarget(group, { ...message, optimistic: 'sending' })).toBeNull();
    expect(qqEssenceTarget(group, { ...message, optimistic: 'failed' })).toBeNull();
    expect(qqEssenceTarget(group, { ...message, optimisticRejected: true })).toBeNull();
  });
});
