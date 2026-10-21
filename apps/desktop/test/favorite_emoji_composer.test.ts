import { describe, expect, it } from 'vitest';
import {
  buildComposerSendPlan,
  buildOptimisticRender,
} from '../src/renderer/src/im-template/template/composerSend';
import {
  favEmojiItem,
  parseMessageParts,
} from '../src/renderer/src/im-template/template/emojiPacks';

describe('收藏表情草稿发送', () => {
  const item = favEmojiItem('personal', '', 'thumb', 'aabbccddeeff.png', '收藏');
  it('兼容已有草稿 token，混排只提交逻辑资源，不把预览地址当成本机文件', () => {
    const plan = buildComposerSendPlan({
      body: `前${item.token}后`,
      locals: [],
      superStickers: new Map(),
    });
    expect(plan).toEqual({
      kind: 'elements',
      elements: [
        { kind: 'text', textContent: '前' },
        {
          kind: 'image',
          source: {
            kind: 'favoriteEmoji',
            scope: 'personal',
            bucket: '',
            variant: 'thumb',
            file: 'aabbccddeeff.png',
          },
        },
        { kind: 'text', textContent: '后' },
      ],
    });
    expect(parseMessageParts(item.token)[0]).toMatchObject({
      type: 'emoji',
      item: { kind: 'fav' },
    });
  });
  it('乐观占位沿用 cemoji 图片预览而非文件名文本', () => {
    const render = buildOptimisticRender({
      body: item.token,
      locals: [],
      superStickers: new Map(),
    });
    expect(render.elements).toEqual([
      { type: 'pic', data: { localPreviewUrl: item.src, subType: 1, summary: '[表情]' } },
    ]);
    expect(render.body).toBe('[表情]');
  });
});
