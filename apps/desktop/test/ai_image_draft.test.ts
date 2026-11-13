import { expect, it } from 'vitest';
import {
  aiImageDraft,
  parseAiImageDraft,
  changeAiImageDraftText,
} from '../src/renderer/src/lib/aiImageDraft';

it('图片草稿使用稳定引用，不保存 Base64，编辑文字不丢失顺序和附件', () => {
  const images = [
    { id: 'one.png', path: '/fixture/one.png', name: '图片一' },
    { id: 'two.png', path: '/fixture/two.png' },
  ];
  const value = aiImageDraft('原文', images);
  expect(value).not.toContain('base64');
  expect(parseAiImageDraft(changeAiImageDraftText(value, '新文字'))).toEqual({
    text: '新文字',
    images,
  });
  expect(parseAiImageDraft(value).images.map((image) => image.id)).toEqual(['one.png', 'two.png']);
});
it('旧文字草稿与损坏标记保留原文，不错误删除正文', () => {
  expect(parseAiImageDraft('旧草稿')).toEqual({ text: '旧草稿', images: [] });
  expect(parseAiImageDraft('正文[[ai-image:broken]]')).toEqual({
    text: '正文[[ai-image:broken]]',
    images: [],
  });
});
