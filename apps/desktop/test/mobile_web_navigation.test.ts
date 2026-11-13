import { act, createElement, useLayoutEffect, useState, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MobileWebNavigation as Navigation } from '../src/renderer/src/components/MobileWebNavigation';
import { OnlineStatus } from '../src/renderer/src/components/OnlineStatus';
import { ChatHeader } from '../src/renderer/src/components/ChatHeader';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';
const { onlineStatusQuery } = vi.hoisted(() => ({ onlineStatusQuery: vi.fn() }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { getOnlineStatus: { useQuery: onlineStatusQuery } } },
  client: {},
}));
vi.mock('../src/renderer/src/components/FaceEmoji', () => ({
  FaceEmoji: () => createElement('img', { alt: '合成状态表情' }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function MobileWebNavigation(props: ComponentProps<typeof Navigation>) {
  const [view, setView] = useState(props.view);
  useLayoutEffect(() => setView(props.view), [props.view]);
  return createElement(Navigation, {
    ...props,
    view,
    onViewChange: (next) => {
      setView(next);
      props.onViewChange(next);
    },
  });
}
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
  await click('频道私聊');
  expect(props.onViewChange).toHaveBeenCalledWith('guild-direct');
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
  const navigation = host.querySelector<HTMLElement>('.weq-mobile-navigation')!;
  expect(navigation.hasAttribute('inert')).toBe(true);
  expect(navigation.getAttribute('aria-hidden')).toBe('true');
  await act(async () => root.render(createElement(MobileWebNavigation, props)));
  expect(navigation.hasAttribute('inert')).toBe(false);
  expect(navigation.getAttribute('aria-hidden')).toBe('false');
});

it('更多中的收藏入口复用现有回调，不增加底栏入口', async () => {
  await act(async () => root.render(createElement(MobileWebNavigation, props)));
  expect(host.textContent).not.toContain('我的收藏');
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  await click('我的收藏');
  expect(props.onOpenCollection).toHaveBeenCalledOnce();
  expect(host.querySelectorAll('nav > button')).toHaveLength(4);
});

it('更多精简重复功能，QQ 资料仍从顶栏头像进入', async () => {
  const onOpenProfile = vi.fn();
  const render = (user = props.user) =>
    root.render(
      createElement(
        ProfileNavigationContext.Provider,
        { value: onOpenProfile },
        createElement(MobileWebNavigation, { ...props, user }),
      ),
    );
  await act(async () => render());
  const avatar = host.querySelector<HTMLButtonElement>('[aria-label="查看我的名片"]')!;
  vi.spyOn(avatar, 'getBoundingClientRect').mockReturnValue({
    right: 68,
    bottom: 40,
  } as DOMRect);
  await click('查看我的名片');
  expect(onOpenProfile).toHaveBeenLastCalledWith(props.user, { x: 68, y: 40 });
  await act(async () =>
    avatar.dispatchEvent(
      new MouseEvent('click', { bubbles: true, detail: 1, clientX: 48, clientY: 24 }),
    ),
  );
  expect(onOpenProfile).toHaveBeenLastCalledWith(props.user, { x: 48, y: 24 });
  const nextUser = { ...props.user, identityValue: '10002' };
  await act(async () => render(nextUser));
  await click('查看我的名片');
  expect(onOpenProfile).toHaveBeenLastCalledWith(nextUser, { x: 68, y: 40 });
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(props.onOpenSettings).not.toHaveBeenCalled();
  expect(host.querySelector('.weq-mobile-actions-toggle')).toBeNull();
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  const more = host.querySelector('[aria-label="更多功能"]')!;
  for (const label of ['QQ 资料与状态', '应用', 'QQ 号搜索', '群号搜索', '好友通知', '群通知'])
    expect(more.textContent).not.toContain(label);
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  expect(host.querySelector('[aria-label="更多功能"]')).toBe(more);
  expect(props.onViewChange).toHaveBeenCalledTimes(1);
});

it('各页面和更多页顶栏始终显示昵称，不再显示页面标题', async () => {
  for (const view of ['messages', 'contacts', 'qzone', 'mail', 'tools'] as const) {
    await act(async () => root.render(createElement(MobileWebNavigation, { ...props, view })));
    expect(host.querySelector('.weq-mobile-account > strong')?.textContent).toBe('合成账号');
    expect(host.querySelector('.weq-mobile-account .avatar')).not.toBeNull();
    expect(host.querySelector('.weq-mobile-header > strong')).toBeNull();
  }
  await act(async () => host.querySelectorAll<HTMLButtonElement>('nav > button')[3]!.click());
  expect(host.querySelector('.weq-mobile-account > strong')?.textContent).toBe('合成账号');
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
    type: 50,
    typeName: '忙碌',
    subType: 0,
    subTypeName: '',
    displayStatus: '忙碌',
    expected: '忙碌',
  },
  {
    type: 70,
    typeName: '勿扰',
    subType: 0,
    subTypeName: '',
    displayStatus: '勿扰',
    expected: '勿扰',
  },
  {
    type: 40,
    typeName: '隐身',
    subType: 0,
    subTypeName: '',
    displayStatus: '隐身',
    expected: '隐身',
  },
  {
    type: 60,
    typeName: 'Q我吧',
    subType: 0,
    subTypeName: '',
    displayStatus: 'Q我吧',
    expected: 'Q我吧',
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

it.each(['awa', '在线 - awa'])('所有入口均并列展示传统与自定义状态：%s', async (displayStatus) => {
  onlineStatusQuery.mockReturnValue({
    data: {
      uid: 'u_fixture',
      type: 10,
      typeName: '在线',
      subType: 2000,
      subTypeName: '',
      displayStatus,
      customStatus: { faceId: 66, faceType: 1, text: 'awa' },
    },
  });
  await act(async () => root.render(createElement(OnlineStatus, { uid: 'u_fixture' })));
  expect(host.textContent).toBe('在线·awa');
  expect(host.firstElementChild?.getAttribute('title')).toBe('在线 - awa');
  expect(host.querySelector('img')?.getAttribute('alt')).toBe('合成状态表情');
});

it('会话标题在手机与桌面均并列展示传统与自定义状态', async () => {
  onlineStatusQuery.mockReturnValue({
    data: {
      uid: 'u_fixture',
      type: 10,
      typeName: '在线',
      subType: 2000,
      subTypeName: '',
      displayStatus: '今天是晴天',
      customStatus: { faceId: 66, faceType: 1, text: '今天是晴天' },
    },
  });
  await act(async () =>
    root.render(
      createElement(ChatHeader, {
        title: '合成昵称 (00.3.12)',
        status: createElement(OnlineStatus, { uid: 'u_fixture' }),
        mobileStatus: createElement(OnlineStatus, { uid: 'u_fixture', showBaseStatus: true }),
        actions: null,
        onBack: vi.fn(),
      }),
    ),
  );
  expect(host.querySelector('.chat-title strong')?.textContent).toBe('合成昵称 (00.3.12)');
  expect(host.querySelector('.chat-status-desktop')?.textContent).toBe('在线·今天是晴天');
  expect(host.querySelector('.chat-status-mobile')?.textContent).toBe('在线·今天是晴天');
  expect(host.querySelector('.chat-status-mobile img')?.getAttribute('alt')).toBe('合成状态表情');
});

it.each(['self', 'peer'])('%s 状态变化后更新实际文案，缺失时不保留在线', async (target) => {
  const uid = `u_${target}`;
  const render = async () => {
    await act(async () =>
      root.render(
        target === 'self'
          ? createElement(MobileWebNavigation, { ...props, user: { ...props.user, uid } })
          : createElement(ChatHeader, {
              title: '合成联系人',
              mobileStatus: createElement(OnlineStatus, {
                uid,
                showBaseStatus: true,
                refetchInterval: 15_000,
              }),
              actions: null,
              onBack: vi.fn(),
            }),
      ),
    );
  };
  const selector = target === 'self' ? '.weq-mobile-online-status' : '.chat-status-mobile';
  for (const [type, typeName] of [
    [10, '在线'],
    [0, '离线'],
    [30, '离开'],
    [50, '忙碌'],
    [70, '勿扰'],
    [40, '隐身'],
    [60, 'Q我吧'],
  ] as const) {
    onlineStatusQuery.mockReturnValue({
      data: { uid, type, typeName, subType: 0, subTypeName: '', displayStatus: typeName },
    });
    await render();
    expect(host.querySelector(selector)?.textContent).toBe(typeName);
  }
  for (const data of [
    null,
    { uid, type: 999, typeName: '未知', displayStatus: '未知' },
    { uid: 'u_other', type: 10, typeName: '在线', displayStatus: '在线' },
  ]) {
    onlineStatusQuery.mockReturnValue({ data });
    await render();
    expect(host.querySelector(selector)?.textContent ?? '').toBe('');
  }
  expect(onlineStatusQuery).toHaveBeenCalledWith(
    { uid },
    { refetchInterval: 15_000, refetchOnMount: 'always' },
  );
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

it('外部导航更新根页面，进入详情后关闭详情仍回到更多且不闪回', async () => {
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
  expect(host.querySelector('[aria-label="更多功能"]')).not.toBeNull();
});
