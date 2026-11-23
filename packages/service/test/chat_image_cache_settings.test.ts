// @vitest-environment node
import { expect, it } from 'vitest';
import { configFixture } from './support/user_config';
import {
  DEFAULT_CHAT_IMAGE_CACHE_MIB,
  MAX_CHAT_IMAGE_CACHE_MIB,
  normalizeChatImageCacheMiB,
} from '../src/common/chat_image_cache';
import {
  DEFAULT_CHAT_MESSAGE_PREWARM_MIB,
  MAX_CHAT_MESSAGE_PREWARM_MIB,
} from '../src/common/chat_message_prewarm';

it('旧配置使用默认预算，新预算包括零值均可持久化并恢复', () => {
  const fixture = configFixture();
  expect(fixture.service.getSettings().chatImageCacheMiB).toBe(DEFAULT_CHAT_IMAGE_CACHE_MIB);
  fixture.service.setSettings({ chatImageCacheMiB: 256 });
  expect(fixture.open().getSettings().chatImageCacheMiB).toBe(256);
  fixture.service.setSettings({ chatImageCacheMiB: 0 });
  fixture.service.setSettings({ showMessageTime: true });
  expect(fixture.open().getSettings().chatImageCacheMiB).toBe(0);
});

it('损坏配置不允许负值、无限预算或非数字；有限数值归一化后落盘', () => {
  for (const [input, expected] of [
    [null, DEFAULT_CHAT_IMAGE_CACHE_MIB],
    ['999', DEFAULT_CHAT_IMAGE_CACHE_MIB],
    [-20, 0],
    [3.9, 3],
    [MAX_CHAT_IMAGE_CACHE_MIB + 1, MAX_CHAT_IMAGE_CACHE_MIB],
  ] as const) {
    const fixture = configFixture({ settings: { chatImageCacheMiB: input } });
    expect(fixture.service.getSettings().chatImageCacheMiB).toBe(expected);
  }
  expect(normalizeChatImageCacheMiB(NaN)).toBe(DEFAULT_CHAT_IMAGE_CACHE_MIB);
  expect(normalizeChatImageCacheMiB(Infinity)).toBe(DEFAULT_CHAT_IMAGE_CACHE_MIB);
});

it('完整消息预算能独立持久化，旧配置默认开启，零值和上限有效', () => {
  const fixture = configFixture({ settings: { chatImageCacheMiB: 256 } });
  expect(fixture.service.getSettings().chatMessagePrewarmMiB).toBe(
    DEFAULT_CHAT_MESSAGE_PREWARM_MIB,
  );
  fixture.service.setSettings({ chatMessagePrewarmMiB: 384 });
  expect(fixture.open().getSettings().chatMessagePrewarmMiB).toBe(384);
  fixture.service.setSettings({ chatMessagePrewarmMiB: MAX_CHAT_MESSAGE_PREWARM_MIB + 1 });
  expect(fixture.open().getSettings().chatMessagePrewarmMiB).toBe(MAX_CHAT_MESSAGE_PREWARM_MIB);
  fixture.service.setSettings({ chatMessagePrewarmMiB: 0 });
  expect(fixture.open().getSettings()).toMatchObject({
    chatMessagePrewarmMiB: 0,
    chatImageCacheMiB: 256,
  });
});
