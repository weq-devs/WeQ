import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  RemoteShellMenuButton,
  RemoteShellMenuItem,
} from '../src/renderer/src/components/RemoteShellMenus';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hosts: HTMLElement[] = [];
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  delete window.weqRemoteShell;
  vi.restoreAllMocks();
});

async function mount() {
  const host = document.createElement('div');
  hosts.push(host);
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement(
          'header',
          { className: 'weq-mobile-header' },
          createElement(RemoteShellMenuButton),
        ),
        createElement(
          'header',
          { className: 'chat-header' },
          createElement('div', { className: 'chat-actions' }),
        ),
        ...[
          'weq-qzn-header',
          'weq-mail-topbar',
          'weq-collection-head',
          'weq-mobile-settings-header',
        ].map((className) => createElement('header', { key: className, className })),
      ),
    ),
  );
  return host;
}

it('普通浏览器不显示连接菜单', async () => {
  const host = await mount();
  expect(host.querySelector('[aria-label="连接菜单"]')).toBeNull();
});

it('省略号仅在手机主顶栏显示，空间、邮箱、收藏、设置内部栏均不注入', async () => {
  const openMenu = vi.fn();
  window.weqRemoteShell = { openMenu };
  const host = await mount();
  expect(host.querySelectorAll('[aria-label="连接菜单"]')).toHaveLength(1);
  const button = host.querySelector<HTMLButtonElement>('.weq-mobile-header > button')!;
  expect(host.querySelectorAll('header:not(.weq-mobile-header) button')).toHaveLength(0);
  await act(async () => button.click());
  expect(openMenu).toHaveBeenCalledOnce();
});

it('Android 加载后只更新主顶栏，后续创建空间和邮箱标题栏也不注入', async () => {
  const host = await mount();
  window.weqRemoteShell = { openMenu: vi.fn() };
  await act(async () => window.dispatchEvent(new Event('weq-remote-shell-ready')));
  const header = document.createElement('header');
  header.className = 'weq-qzn-header';
  await act(async () => {
    host.firstElementChild!.append(header);
  });
  expect(header.querySelectorAll('button')).toHaveLength(0);
  await act(async () => window.dispatchEvent(new Event('weq-remote-shell-ready')));
  expect(host.querySelectorAll('[aria-label="连接菜单"]')).toHaveLength(1);
  expect(header.querySelectorAll('button')).toHaveLength(0);
});

it('聊天页复用已有更多菜单，先收起网页菜单再唤起原生连接菜单', async () => {
  const calls: string[] = [];
  window.weqRemoteShell = { openMenu: () => calls.push('native') };
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList);
  const host = await mount();
  const extra = document.createElement('div');
  hosts.push(extra);
  host.append(extra);
  const root = createRoot(extra);
  roots.push(root);
  await act(async () =>
    root.render(createElement(RemoteShellMenuItem, { onClose: () => calls.push('close') })),
  );
  await act(async () => extra.querySelector<HTMLButtonElement>('button')!.click());
  expect(calls).toEqual(['close', 'native']);
  expect(host.querySelector('.chat-actions > .weq-remote-shell-menu')).toBeNull();
});
