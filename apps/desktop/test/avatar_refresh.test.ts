import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QqAvatar } from '../src/renderer/src/components/QqAvatar';
import { refreshGroupAvatar, refreshUserAvatar } from '../src/renderer/src/hooks/useAvatarUrl';

afterEach(() => vi.unstubAllGlobals());

it('群头像改动仅刷新目标群，已挂载图片重置失败状态，不改上游 URL', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const source = 'https://p.qlogo.cn/gh/123/123/0';
  act(() =>
    root.render(
      h(
        'div',
        null,
        h(QqAvatar, { url: source }),
        h(QqAvatar, { url: 'https://p.qlogo.cn/gh/456/456/0' }),
      ),
    ),
  );
  try {
    const [first, other] = host.querySelectorAll('img');
    const before = first!.getAttribute('src');
    const otherBefore = other!.getAttribute('src');
    act(() => first!.dispatchEvent(new Event('error')));
    expect(host.querySelectorAll('img')).toHaveLength(1);
    act(() => refreshGroupAvatar('123'));
    const [updated, unchanged] = host.querySelectorAll('img');
    expect(updated!.getAttribute('src')).not.toBe(before);
    const url = new URL(updated!.getAttribute('src')!);
    expect(url.searchParams.get('fb')).toBe(source);
    expect(url.searchParams.get('_weq_avatar_remote')).toBe('1');
    expect(unchanged!.getAttribute('src')).toBe(otherBefore);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('个人头像按 QQ 号刷新，与同号群头像隔离', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      h(
        'div',
        null,
        h(QqAvatar, { uin: '10001' }),
        h(QqAvatar, { url: 'https://p.qlogo.cn/gh/10001/10001/0' }),
      ),
    ),
  );
  try {
    const [user, group] = host.querySelectorAll('img');
    const before = user!.getAttribute('src');
    const groupBefore = group!.getAttribute('src');
    act(() => refreshUserAvatar('10001'));
    expect(user!.getAttribute('src')).not.toBe(before);
    expect(user!.getAttribute('src')).toContain('_weq_avatar_remote=1');
    expect(group!.getAttribute('src')).toBe(groupBefore);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
