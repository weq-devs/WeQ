import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteShellMenus } from '../src/renderer/src/components/RemoteShellMenus';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const hosts: HTMLElement[] = [];
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  for (const host of hosts.splice(0)) host.remove();
  delete window.weqRemoteShell;
});

async function mount() {
  const host = document.createElement('div');
  hosts.push(host);
  document.body.append(host);
  const ref = createRef<HTMLDivElement>();
  const root = createRoot(host);
  roots.push(root);
  await act(async () =>
    root.render(
      createElement(
        'div',
        { ref },
        createElement('header', { className: 'weq-mobile-header' }),
        createElement(
          'header',
          { className: 'chat-header' },
          createElement('div', { className: 'chat-actions' }),
        ),
        createElement(RemoteShellMenus, { root: ref }),
      ),
    ),
  );
  return host;
}

it('普通浏览器不显示连接菜单', async () => {
  const host = await mount();
  expect(host.querySelector('[aria-label="连接菜单"]')).toBeNull();
});

it('桥接可用时在主顶栏和详情工具栏显示入口，点击不发网络请求', async () => {
  const openMenu = vi.fn();
  window.weqRemoteShell = { openMenu };
  const host = await mount();
  expect(host.querySelectorAll('[aria-label="连接菜单"]')).toHaveLength(2);
  const button = host.querySelector<HTMLButtonElement>('.chat-actions > button')!;
  await act(async () => button.click());
  expect(openMenu).toHaveBeenCalledOnce();
});

it('Android 加载后注入桥接、后续进入新页面时补上入口且不重复', async () => {
  const host = await mount();
  window.weqRemoteShell = { openMenu: vi.fn() };
  await act(async () => window.dispatchEvent(new Event('weq-remote-shell-ready')));
  const header = document.createElement('header');
  header.className = 'chat-header';
  await act(async () => {
    host.firstElementChild!.append(header);
  });
  expect(header.querySelectorAll('button')).toHaveLength(1);
  await act(async () => window.dispatchEvent(new Event('weq-remote-shell-ready')));
  expect(header.querySelectorAll('button')).toHaveLength(1);
});

it('聊天栏已有更多会话操作时不再重复添加省略号，消息内容中的 header 不添加菜单', async () => {
  window.weqRemoteShell = { openMenu: vi.fn() };
  const host = await mount();
  const chat = document.createElement('header');
  chat.className = 'chat-header';
  const more = document.createElement('button');
  more.setAttribute('aria-label', '更多会话操作');
  chat.append(more);
  const article = document.createElement('article');
  article.append(document.createElement('header'));
  await act(async () => host.firstElementChild!.append(chat, article));
  expect(chat.querySelector('.weq-remote-shell-menu')).toBeNull();
  expect(article.querySelector('.weq-remote-shell-menu')).toBeNull();
});
