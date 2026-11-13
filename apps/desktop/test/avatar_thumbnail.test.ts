import { afterEach, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QqAvatar } from '../src/renderer/src/components/QqAvatar';
import { cachedAvatarUrl } from '../src/renderer/src/lib/avatarCache';
import { setPreferCdnFlag } from '../src/renderer/src/lib/cdn';

afterEach(() => setPreferCdnFlag(false));

it('小头像控件复用列表缩略图，较大的头像仍使用原图', () => {
  const render = (size: number) => {
    const markup = renderToStaticMarkup(createElement(QqAvatar, { uin: '10001', size }));
    const host = document.createElement('div');
    host.innerHTML = markup;
    return host.querySelector('img')!.getAttribute('src');
  };
  const source = 'https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=10001';
  expect(render(40)).toBe(cachedAvatarUrl(source, 'small'));
  expect(render(128)).toBe(cachedAvatarUrl(source, 'big'));
});

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

it('同一 QQ 头像的参数顺序和已知 CDN 别名共用地址，清晰度仍分开', () => {
  const first = 'https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=10001';
  const other = 'https://q1.qlogo.cn/g?nk=10001&b=sdk&s=0';
  expect(cachedAvatarUrl(other)).toBe(cachedAvatarUrl(first));
  expect(cachedAvatarUrl(other, 'small')).toBe(cachedAvatarUrl(first, 'small'));
  expect(cachedAvatarUrl(first, 'small')).not.toBe(cachedAvatarUrl(first));
  expect(cachedAvatarUrl('https://q1.qlogo.cn/g?b=sdk&s=0&nk=10002')).not.toBe(
    cachedAvatarUrl(first),
  );
});

it('重复包装的头像仍复用规范地址，不丢显式刷新参数，不改签名与站外 URL', () => {
  const first = 'https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=10001';
  const wrapped = cachedAvatarUrl(first)!;
  expect(cachedAvatarUrl(wrapped, 'small')).toBe(cachedAvatarUrl(first, 'small'));
  const refresh = `${wrapped}&_weq_avatar_refresh=12&_weq_avatar_remote=1`;
  expect(cachedAvatarUrl(refresh, 'small')).toContain('_weq_avatar_refresh=12');
  expect(cachedAvatarUrl(refresh, 'small')).toContain('_weq_avatar_remote=1');
  setPreferCdnFlag(true);
  const signed = 'https://q1.qlogo.cn/g?b=sdk&s=0&nk=10001&signature=keep';
  expect(cachedAvatarUrl(signed)).toBe(signed);
  const external = 'https://example.test/g?nk=10001&b=sdk&s=0';
  expect(new URL(cachedAvatarUrl(external)!).searchParams.get('src')).toBe(external);
});
