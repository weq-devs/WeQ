import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileWebNavigation } from '../src/renderer/src/components/MobileWebNavigation';
import { OnlineStatus } from '../src/renderer/src/components/OnlineStatus';
const { onlineStatusQuery } = vi.hoisted(() => ({ onlineStatusQuery: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { getOnlineStatus: { useQuery: onlineStatusQuery } } },
  client: {},
}));
vi.mock('../src/renderer/src/components/FaceEmoji', () => ({
  FaceEmoji: () => createElement('img', { alt: '合成状态表情' }),
}));

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
  onlineStatusQuery.mockReturnValue({ data: null });
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

it('顶栏移除加号，资料与更多中的联系人操作复用原有回调', async () => {
  const onOpenProfile = vi.fn(),
    onLookupUser = vi.fn(),
    onLookupGroup = vi.fn();
  const onOpenFriendNotices = vi.fn(),
    onOpenGroupNotices = vi.fn();
  await act(async () =>
    root.render(
      createElement(MobileWebNavigation, {
        ...props,
        onOpenProfile,
        onLookupUser,
        onLookupGroup,
        onOpenFriendNotices,
        onOpenGroupNotices,
      }),
    ),
  );
  await click('编辑 QQ 资料');
  expect(onOpenProfile).toHaveBeenCalledOnce();
  expect(host.querySelector('.weq-mobile-actions-toggle')).toBeNull();
  for (const [label, action] of [
    ['QQ 号搜索', onLookupUser],
    ['群号搜索', onLookupGroup],
    ['好友通知', onOpenFriendNotices],
    ['群通知', onOpenGroupNotices],
  ] as const) {
    await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
    await click(label);
    expect(action).toHaveBeenCalledOnce();
    expect(host.querySelector('[aria-label="更多功能"]')).toBeNull();
  }
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  expect(host.querySelector('[aria-label="更多功能"]')).toBeNull();
});

it('各页面和更多页顶栏始终显示昵称，不再显示页面标题', async () => {
  for (const view of ['messages', 'contacts', 'qzone', 'mail', 'tools'] as const) {
    await act(async () => root.render(createElement(MobileWebNavigation, { ...props, view })));
    expect(host.querySelector('.weq-mobile-identity > strong')?.textContent).toBe('合成账号');
    expect(host.querySelector('.weq-mobile-header > strong')).toBeNull();
  }
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  expect(host.querySelector('.weq-mobile-identity > strong')?.textContent).toBe('合成账号');
});

it.each([
  {
    type: 10,
    typeName: '在线',
    subType: 0,
    subTypeName: '',
    displayStatus: '在线',
    expected: '在线',
  },
  {
    type: 0,
    typeName: '离线',
    subType: 0,
    subTypeName: '',
    displayStatus: '离线',
    expected: '离线',
  },
  {
    type: 30,
    typeName: '离开',
    subType: 0,
    subTypeName: '',
    displayStatus: '离开',
    expected: '离开',
  },
  {
    type: 10,
    typeName: '在线',
    subType: 1028,
    subTypeName: '听歌中',
    displayStatus: '在线 - 听歌中',
    expected: '在线·听歌中',
  },
  {
    type: 10,
    typeName: '在线',
    subType: 2000,
    subTypeName: '',
    displayStatus: 'awa',
    customStatus: { faceId: 66, faceType: 1, text: 'awa' },
    expected: '在线·awa',
  },
])('顶栏显示实际状态：$expected', async ({ expected, ...status }) => {
  onlineStatusQuery.mockReturnValue({ data: { ...status, uid: 'u_fixture' } });
  await act(async () =>
    root.render(
      createElement(MobileWebNavigation, {
        ...props,
        user: { ...props.user, uid: 'u_fixture' },
      }),
    ),
  );
  expect(host.querySelector('.weq-mobile-online-status')?.textContent).toBe(expected);
  expect(onlineStatusQuery).toHaveBeenCalledWith(
    { uid: 'u_fixture' },
    { refetchInterval: 15_000, refetchOnMount: 'always' },
  );
});

it.each([null, { uid: 'u_other', typeName: '在线' }, { uid: 'u_fixture', typeName: '未知' }])(
  '状态缺失、未知或属于其他账号时不误报在线',
  async (data) => {
    onlineStatusQuery.mockReturnValue({ data });
    await act(async () =>
      root.render(
        createElement(MobileWebNavigation, {
          ...props,
          user: { ...props.user, uid: 'u_fixture' },
        }),
      ),
    );
    expect(host.querySelector('.weq-mobile-online-status')).toBeNull();
  },
);

it('桌面等现有入口未启用基础状态展示时保持原有文案', async () => {
  onlineStatusQuery.mockReturnValue({
    data: {
      uid: 'u_fixture',
      type: 10,
      typeName: '在线',
      subType: 2000,
      subTypeName: '',
      displayStatus: 'awa',
      customStatus: { faceId: 66, faceType: 1, text: 'awa' },
    },
  });
  await act(async () => root.render(createElement(OnlineStatus, { uid: 'u_fixture' })));
  expect(host.textContent).toBe('awa');
});

it.each([0, 123])('消息汇总数为 %s 时再次点击消息入口仍可定位', async (messageBadgeCount) => {
  const locateUnread = vi.fn();
  await act(async () =>
    root.render(
      createElement(MobileWebNavigation, {
        ...props,
        messageBadgeCount,
        onMessageBadgeClick: locateUnread,
      }),
    ),
  );
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[0]!.click());
  expect(locateUnread).toHaveBeenCalledOnce();
  expect(props.onViewChange).not.toHaveBeenCalled();
});

it('外部导航或进入详情后，不保留遮挡新页面的更多菜单', async () => {
  await act(async () => root.render(createElement(MobileWebNavigation, props)));
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  await act(async () =>
    root.render(createElement(MobileWebNavigation, { ...props, view: 'qzone' })),
  );
  expect(host.querySelector('[aria-label="更多功能"]')).toBeNull();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  await act(async () =>
    root.render(createElement(MobileWebNavigation, { ...props, view: 'qzone', hidden: true })),
  );
  await act(async () =>
    root.render(createElement(MobileWebNavigation, { ...props, view: 'qzone' })),
  );
  expect(host.querySelector('[aria-label="更多功能"]')).toBeNull();
});
