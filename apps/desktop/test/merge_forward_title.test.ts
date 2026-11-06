import { describe, expect, it } from 'vitest';
import {
  createEmptyDraft,
  createNode,
  draftCardPreview,
  draftTitle,
} from '../src/renderer/src/components/mergeForward/model';

describe('合并转发默认标题', () => {
  const nodes = ['甲', '乙', '丙'].map((name) =>
    createNode({ uid: '', uin: '', name }, [{ t: 'text', id: name, text: '消息' }]),
  );

  it.each([0, 1, 2, 3])('群记录包含 %i 个发言人时均使用群聊标题', (count) => {
    expect(draftTitle(nodes.slice(0, count), 'group')).toBe('群聊的聊天记录');
  });

  it('私聊仍按发言人生成标题', () => {
    expect(draftTitle(nodes.slice(0, 1), 'c2c')).toBe('甲的聊天记录');
    expect(draftTitle(nodes.slice(0, 2), 'c2c')).toBe('甲和乙的聊天记录');
  });

  it.each(['群聊的聊天记录', '自定义标题'])('卡片预览沿用草稿标题：%s', (title) => {
    expect(draftCardPreview({ ...createEmptyDraft(), title, nodes }).source).toBe(title);
  });
});
