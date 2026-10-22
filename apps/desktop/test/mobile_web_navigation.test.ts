import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileWebNavigation } from '../src/renderer/src/components/MobileWebNavigation';
vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const props = {
  user: {
    id: 'fixture',
    username: '合成账号',
    displayName: '合成账号',
    identityLabel: 'QQ',
    identityValue: '10001',
    avatarUrl: null,
  },
  view: 'messages' as const,
  hidden: false,
  query: '',
  onQueryChange: vi.fn(),
  messageBadgeCount: 123,
  contactBadgeCount: 2,
  mailBadgeCount: 3,
  onViewChange: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenDressUp: vi.fn(),
  onOpenCollection: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(
    (element) => element.textContent === label || element.getAttribute('aria-label') === label,
  );
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}

it('底栏固定四个入口，未读数封顶但不会增加导航宽度', async () => {
  await act(async () => root.render(createElement(MobileWebNavigation, props)));
  const tabs = host.querySelectorAll('nav > button');
  expect(tabs).toHaveLength(4);
  expect(tabs[0]!.getAttribute('aria-current')).toBe('page');
  expect(tabs[0]!.textContent).toContain('99+');
  expect(host.querySelector('[aria-label="更多功能"]')).toBeNull();
});

it('更多保留全部次级入口，选中后关闭列表并调用原有操作', async () => {
  await act(async () => root.render(createElement(MobileWebNavigation, props)));
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  expect(host.querySelector('[aria-label="更多功能"]')).not.toBeNull();
  await click('QQ 频道');
  expect(props.onViewChange).toHaveBeenCalledWith('channel');
  expect(host.querySelector('[aria-label="更多功能"]')).toBeNull();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  await click('设置');
  expect(props.onOpenSettings).toHaveBeenCalledOnce();
});

it('搜索在手机标题中可展开，聊天详情隐藏整套主导航', async () => {
  await act(async () => root.render(createElement(MobileWebNavigation, props)));
  await click('全局搜索');
  expect(host.querySelector<HTMLInputElement>('input')!.disabled).toBe(false);
  await act(async () =>
    root.render(createElement(MobileWebNavigation, { ...props, hidden: true })),
  );
  expect(host.querySelector<HTMLElement>('.weq-mobile-navigation')!.hidden).toBe(true);
});

it('原有账号和快捷控制保留在更多页，不放进拥挤的底栏', async () => {
  const switchAccount = vi.fn();
  await act(async () =>
    root.render(
      createElement(MobileWebNavigation, {
        ...props,
        accountControls: createElement('button', { onClick: switchAccount }, '切换账号'),
      }),
    ),
  );
  expect(host.textContent).not.toContain('切换账号');
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  await click('切换账号');
  expect(switchAccount).toHaveBeenCalledOnce();
  expect(host.querySelectorAll('nav > button')).toHaveLength(4);
});

it('在消息列表再次点击消息入口，保留定位首条未读的能力', async () => {
  const locateUnread = vi.fn();
  await act(async () =>
    root.render(
      createElement(MobileWebNavigation, { ...props, onMessageBadgeClick: locateUnread }),
    ),
  );
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[0]!.click());
  expect(locateUnread).toHaveBeenCalledOnce();
  expect(props.onViewChange).not.toHaveBeenCalled();
});
