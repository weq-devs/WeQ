/**
 * 闪照兜底文案的识别（渲染层）。
 *
 * 本地库里闪照只剩一句 `[闪照]请使用新版手机QQ查看闪照。`，`commonElem(serviceType=3)`
 * 元素从来没落过库。渲染层靠这句话认出「这条需要走协议补拉」，所以判据必须严格：
 * 只有**整条消息恰好是一条这样的文本**才算，正常聊天里提到这句话的句子不算。
 */

import { describe, expect, it } from 'vitest';
import {
  FLASH_PHOTO_PLACEHOLDER_TEXT,
  isFlashPhotoPlaceholderText,
} from '../src/renderer/src/lib/flashPhoto';

describe('闪照兜底文案', () => {
  it('文案与协议层常量一致（两处必须一起改）', () => {
    expect(FLASH_PHOTO_PLACEHOLDER_TEXT).toBe('[闪照]请使用新版手机QQ查看闪照。');
  });

  it('完全一致才算（含首尾空白）', () => {
    expect(isFlashPhotoPlaceholderText(FLASH_PHOTO_PLACEHOLDER_TEXT)).toBe(true);
    expect(isFlashPhotoPlaceholderText(`  ${FLASH_PHOTO_PLACEHOLDER_TEXT}\n`)).toBe(true);
  });

  it('只是包含这句话的普通句子不算', () => {
    expect(isFlashPhotoPlaceholderText(`他说${FLASH_PHOTO_PLACEHOLDER_TEXT}`)).toBe(false);
    expect(isFlashPhotoPlaceholderText('[闪照]')).toBe(false);
    expect(isFlashPhotoPlaceholderText('')).toBe(false);
  });
});
