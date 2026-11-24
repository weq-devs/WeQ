import { act, createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createQueryRoot } from './support/query_root';
import { MobileWebNavigation } from '../src/renderer/src/components/MobileWebNavigation';
import { mobileBack } from '../src/renderer/src/hooks/useMobileNavigation';
import type { MobileNavigationChange } from '../src/renderer/src/lib/mobileNavigation';

vi.mock('../src/renderer/src/lib/target', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/lib/target.shared', () => ({ IS_WEB: true }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: { getDevelopmentFeatures: { useQuery: () => ({ data: { dressTools: false } }) } },
  },
  client: {},
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let host: HTMLDivElement;
let root: ReturnType<typeof createQueryRoot>;
let directions: string[];
const onNavigate = (event: Event) =>
  directions.push((event as CustomEvent<MobileNavigationChange>).detail.direction);
const props: ComponentProps<typeof MobileWebNavigation> = {
  user: {
    id: 'fixture',
    username: '合成账号',
    displayName: '合成账号',
    identityLabel: 'QQ',
    identityValue: '10001',
    avatarUrl: null,
  },
  view: 'mail',
  hidden: false,
  query: '',
  onQueryChange: vi.fn(),
  messageBadgeCount: 0,
  contactBadgeCount: 0,
  onViewChange: vi.fn(),
  onOpenSettings: vi.fn(),
  onOpenDressUp: vi.fn(),
  onOpenCollection: vi.fn(),
};

beforeEach(() => {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media) => Object.assign(new EventTarget(), { matches: true, media }) as MediaQueryList,
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createQueryRoot(host);
  directions = [];
  window.addEventListener('weq-mobile-navigate', onNavigate);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.removeEventListener('weq-mobile-navigate', onNavigate);
  host.remove();
  vi.restoreAllMocks();
});

it.each(['mail', 'home', 'guild-direct', 'annual'] as const)(
  '%s 页面数据刷新不重播导航动画，返回仍调用最新回调',
  async (view) => {
    const previous = vi.fn();
    await act(async () =>
      root.render(createElement(MobileWebNavigation, { ...props, view, onViewChange: previous })),
    );
    expect(directions).toEqual(['forward']);
    directions.length = 0;
    let latest = vi.fn();
    for (let count = 0; count < 10; count++) {
      latest = vi.fn();
      await act(async () =>
        root.render(
          createElement(MobileWebNavigation, {
            ...props,
            view,
            messageBadgeCount: count,
            onViewChange: latest,
          }),
        ),
      );
    }
    expect(directions).toEqual([]);
    expect(mobileBack()).toBe(true);
    expect(latest).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenCalledWith('more');
    expect(previous).not.toHaveBeenCalled();
    expect(directions).toEqual(['back']);
  },
);

it('真正切换次级页面或离开次级页面时仍更新返回层级', async () => {
  await act(async () => root.render(createElement(MobileWebNavigation, props)));
  directions.length = 0;
  await act(async () =>
    root.render(createElement(MobileWebNavigation, { ...props, view: 'home' })),
  );
  expect(directions).toEqual(['back', 'forward']);
  directions.length = 0;
  await act(async () =>
    root.render(createElement(MobileWebNavigation, { ...props, view: 'more' })),
  );
  expect(directions).toEqual(['back']);
  expect(mobileBack()).toBe(false);
});
