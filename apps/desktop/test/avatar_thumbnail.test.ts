import { afterEach, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { QqAvatar } from '../src/renderer/src/components/QqAvatar';
import { WebAvatarScope } from '../src/renderer/src/hooks/useAvatarImage';
import { refreshUserAvatar } from '../src/renderer/src/hooks/useAvatarUrl';
import { Avatar } from '../src/renderer/src/im-template/template/primitives';
import { cachedAvatarUrl } from '../src/renderer/src/lib/avatarCache';
import { setPreferCdnFlag } from '../src/renderer/src/lib/cdn';
import { avatarStore, webAvatarCache, webAvatarKey } from '../src/renderer/src/lib/webAvatarCache';

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

it('桌面端的失败头像会复用同一人随后加载成功的另一来源，与同号群隔离', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const select = (surface: string) => host.querySelector(`.${surface} img`);
  const uin = '12345';
  try {
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(
            'div',
            { className: 'small' },
            createElement(Avatar, {
              name: '联系人',
              resolution: 'small',
              avatarUrl: `https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=${uin}`,
            }),
          ),
          createElement(
            'div',
            { className: 'card' },
            createElement(QqAvatar, {
              uin,
              size: 128,
              url: 'https://qh.qlogo.cn/g?b=qq&ek=fixture&s=0',
            }),
          ),
          createElement(
            'div',
            { className: 'group' },
            createElement(QqAvatar, {
              url: `https://p.qlogo.cn/gh/${uin}/${uin}/0`,
            }),
          ),
        ),
      ),
    );
    act(() => {
      select('small')!.dispatchEvent(new Event('error'));
      select('group')!.dispatchEvent(new Event('error'));
    });
    expect(select('small')).toBeNull();
    act(() => select('card')!.dispatchEvent(new Event('load')));
    expect(select('small')?.getAttribute('src')).toBe(select('card')?.getAttribute('src'));
    expect(select('group')).toBeNull();

    act(() => select('small')!.dispatchEvent(new Event('error')));
    expect(select('small')).toBeNull();
    act(() => select('card')!.dispatchEvent(new Event('load')));
    expect(select('small')?.getAttribute('src')).toBe(select('card')?.getAttribute('src'));

    act(() => refreshUserAvatar(uin));
    act(() => select('small')!.dispatchEvent(new Event('error')));
    expect(select('small')).toBeNull();
    act(() => select('card')!.dispatchEvent(new Event('load')));
    expect(select('small')?.getAttribute('src')).toContain('_weq_avatar_remote=1');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('同地址已有成功记录时，失败的头像使用新节点重新加载', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(QqAvatar, { uin: '12346', className: 'first' }),
          createElement(QqAvatar, { uin: '12346', className: 'second' }),
        ),
      ),
    );
    const first = host.querySelector('img.first')!;
    const second = host.querySelector('img.second')!;
    act(() => first.dispatchEvent(new Event('load')));
    act(() => second.dispatchEvent(new Event('error')));
    const retried = host.querySelector('img.second');
    expect(retried).not.toBe(second);
    expect(retried?.getAttribute('src')).toBe(first.getAttribute('src'));
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

const loaded = () => new Response(new Blob(['avatar'], { type: 'image/png' }));

function renderWebAvatars(scope: string, fetchImage: (src: string) => Promise<Response>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal('fetch', fetchImage);
  vi.stubGlobal(
    'Image',
    class {
      naturalWidth = 32;
      naturalHeight = 32;
      decode = async () => {};
      removeAttribute = () => {};
    },
  );
  vi.spyOn(avatarStore, 'get').mockResolvedValue(undefined);
  vi.spyOn(avatarStore, 'put').mockResolvedValue(undefined);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    render: (...avatars: ReactNode[]) =>
      act(async () => {
        root.render(createElement(WebAvatarScope.Provider, { value: scope }, ...avatars));
      }),
    ready: (src: string) =>
      act(async () => {
        await vi.waitFor(() =>
          expect(webAvatarCache.peek(webAvatarKey(scope, src)!)?.ready).toBe(true),
        );
      }),
    close: () => {
      act(() => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    },
  };
}

it('Remote 缩略图失败可自行补取原图，另一处原图失败也会复用后续加载成功的缩略图', async () => {
  const scope = 'chat-avatar-fixture';
  const own = '/_media/avatar?scope=user&uin=10001&v=big';
  const peer = '/_media/avatar?scope=user&uin=10002&v=big';
  const ownThumbnail = cachedAvatarUrl(own, 'small')!;
  const peerThumbnail = cachedAvatarUrl(peer, 'small')!;
  let loadPeerThumbnail!: (response: Response) => void;
  const pendingThumbnail = new Promise<Response>((resolve) => {
    loadPeerThumbnail = resolve;
  });
  const fetchImage = vi.fn(async (src: string) =>
    src === ownThumbnail || src === peer
      ? new Response(null, { status: 404 })
      : src === peerThumbnail
        ? pendingThumbnail
        : loaded(),
  );
  const fixture = renderWebAvatars(scope, fetchImage);
  try {
    await fixture.render(
      createElement(Avatar, { name: '本人', avatarUrl: own, resolution: 'small' }),
      createElement(Avatar, { name: '对方', avatarUrl: peer, resolution: 'small' }),
      createElement(QqAvatar, { url: peer, size: 128, className: 'peer-card' }),
    );
    await fixture.ready(own);
    expect(webAvatarCache.peek(webAvatarKey(scope, peer)!)?.failed).toBe(true);
    expect(fixture.host.querySelector('img.peer-card')).toBeNull();
    await act(async () => loadPeerThumbnail(loaded()));
    const srcs = [...fixture.host.querySelectorAll('img')].map((image) =>
      image.getAttribute('src'),
    );
    expect(srcs).toEqual([
      webAvatarCache.peek(webAvatarKey(scope, own)!)?.src,
      webAvatarCache.peek(webAvatarKey(scope, peerThumbnail)!)?.src,
      webAvatarCache.peek(webAvatarKey(scope, peerThumbnail)!)?.src,
    ]);
    expect(fetchImage.mock.calls.map(([src]) => src).sort()).toEqual(
      [ownThumbnail, own, peerThumbnail, peer].sort(),
    );
  } finally {
    fixture.close();
  }
});

it('Remote 同一张已缓存头像在一个位置报错时可原地重试，不影响别处且不重复下载', async () => {
  const url = '/_media/avatar?scope=user&uin=10003&v=big';
  const fetchImage = vi.fn(async () => loaded());
  const fixture = renderWebAvatars('same-avatar-fixture', fetchImage);
  try {
    await fixture.render(
      createElement(QqAvatar, { url, className: 'sidebar' }),
      createElement(Avatar, { name: '发送者', avatarUrl: url, resolution: 'small' }),
    );
    await fixture.ready(cachedAvatarUrl(url, 'small')!);
    const sidebar = fixture.host.querySelector('img.sidebar');
    const sender = () => fixture.host.querySelector('.avatar img');
    const failed = sender()!;
    expect(failed.getAttribute('src')).toBe(sidebar?.getAttribute('src'));

    act(() => failed.dispatchEvent(new Event('error')));
    expect(sender()).not.toBe(failed);
    expect(sender()?.getAttribute('src')).toBe(sidebar?.getAttribute('src'));

    act(() => sender()!.dispatchEvent(new Event('error')));
    expect(sender()).toBeNull();
    expect(fixture.host.querySelector('img.sidebar')).toBe(sidebar);
    expect(fetchImage).toHaveBeenCalledTimes(1);
  } finally {
    fixture.close();
  }
});

it('Remote 不等缩略图请求结束就显示同一人的已缓存原图，缩略图成功后换回', async () => {
  const url = '/_media/avatar?scope=user&uin=10004&v=big';
  const headerUrl = `/_avatar/fetch?${new URLSearchParams({ src: 'https://thirdqq.qlogo.cn/g?b=sdk&s=0&nk=10004' })}`;
  const small = cachedAvatarUrl(url, 'small')!;
  let finishThumbnail!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finishThumbnail = resolve;
  });
  const fetchImage = vi.fn(async (src: string) => (src === small ? pending : loaded()));
  const fixture = renderWebAvatars('pending-avatar-fixture', fetchImage);
  const header = createElement(QqAvatar, { url: headerUrl, size: 128, className: 'header' });
  try {
    await fixture.render(header);
    await fixture.ready(headerUrl);
    await fixture.render(
      header,
      createElement(Avatar, { name: '发送者', avatarUrl: url, resolution: 'small' }),
    );
    const original = fixture.host.querySelector('img.header')!.getAttribute('src');
    const sender = () => fixture.host.querySelector('.avatar img')?.getAttribute('src');
    expect(original).toMatch(/^blob:/);
    expect(sender()).toBe(original);
    expect(fetchImage.mock.calls.map(([src]) => src)).toEqual([headerUrl, small]);

    await act(async () => finishThumbnail(loaded()));
    await fixture.ready(small);
    expect(sender()).toMatch(/^blob:/);
    expect(sender()).not.toBe(original);
  } finally {
    fixture.close();
  }
});
