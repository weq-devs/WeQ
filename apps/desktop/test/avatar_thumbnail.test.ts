import { afterEach, expect, it } from 'vitest';
import { cachedAvatarUrl } from '../src/renderer/src/lib/avatarCache';
import { setPreferCdnFlag } from '../src/renderer/src/lib/cdn';

afterEach(() => setPreferCdnFlag(false));

it('小头像使用本地缩略图与小尺寸回退，原图入口保持原请求', () => {
  setPreferCdnFlag(false);
  const source = 'https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=10001';
  const small = new URL(cachedAvatarUrl(source, 'small')!);
  expect(small.searchParams.get('v')).toBe('small');
  expect(new URL(small.searchParams.get('fb')!).searchParams.get('s')).toBe('100');
  const original = new URL(cachedAvatarUrl(source)!);
  expect(original.searchParams.get('v')).toBe('big');
  expect(original.searchParams.get('fb')).toBe(source);
  const wrapped = new URL(cachedAvatarUrl(original.href, 'small')!);
  expect(wrapped.searchParams.get('v')).toBe('small');
});

it('CDN 优先的小头像仍使用小尺寸，不改变其他远程媒体', () => {
  setPreferCdnFlag(true);
  expect(new URL(cachedAvatarUrl('https://p.qlogo.cn/gh/70001/70001/0', 'small')!).pathname).toBe(
    '/gh/70001/70001/100',
  );
  const source = 'https://example.test/cover.png';
  expect(cachedAvatarUrl(source, 'small')).toBe(cachedAvatarUrl(source));
});
