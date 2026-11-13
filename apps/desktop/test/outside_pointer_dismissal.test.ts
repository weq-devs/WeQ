import { act, createElement as h, type ComponentProps } from 'react';
import { Smile } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';
import { ReactionPicker } from '../src/renderer/src/im-template/template/reactionPicker';
import { useSearchDismissal } from '../src/renderer/src/hooks/useSearchDismissal';
import { focusComposerEnd } from '../src/renderer/src/im-template/template/composer';
import { AppRail } from '../src/renderer/src/im-template/template/rail';
import { SidebarHeader } from '../src/renderer/src/im-template/template/sidebarHeader';
import { MergedSessionPanel } from '../src/renderer/src/components/sidebar/MergedSessionPanel';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn() })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => root.render(element));
  return host;
}

function press(target: Element, pointerType = 'mouse') {
  act(() =>
    target.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId: 1,
        pointerType,
        clientX: 10,
        clientY: 40,
      }),
    ),
  );
}

/**
 * 面板本体走 lazyPanel（React.lazy + Suspense）：首次点击只挂起出加载态，
 * 要等动态 import 真正完成、React 重试渲染后 DOM 里才有 `.<panel>`。
 */
async function settleLazyPanels() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

async function clickTitle(host: ParentNode, title: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[title="${title}"]`);
  expect(button, title).not.toBeNull();
  await act(async () => button!.click());
  await settleLazyPanels();
}

async function choose(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (row) => row.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
  await settleLazyPanels();
}

function mountChat(props: Partial<ComponentProps<typeof ChatPane>> = {}) {
  const demo = createTemplateDemoData();
  const host = mount(
    h(ChatPane, {
      user: demo.user,
      conversation: demo.conversations.find((row) => row.type === 'group')!,
      messages: [],
      draft: '',
      loading: false,
      onDraftChange: vi.fn(),
      onBack: vi.fn(),
      ...props,
    }),
  );
  const scroll = host.querySelector<HTMLElement>('.message-scroll')!;
  vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 500, 300));
  Object.defineProperty(scroll, 'clientWidth', { value: 500 });
  return { host, scroll };
}

it.each([
  ['表情', '.emoji-panel'],
  ['语音', '.voice-panel'],
  ['发送 Ark 卡片', '.ark-panel'],
])('点击框选空白区关闭%s面板，内部和触发按钮不误关', async (title, selector) => {
  const { host, scroll } = mountChat();
  await clickTitle(host, title);
  const panel = host.querySelector(selector)!;
  expect(panel).not.toBeNull();
  press(panel);
  expect(host.querySelector(selector)).not.toBeNull();
  press(host.querySelector(`button[title="${title}"]`)!);
  expect(host.querySelector(selector)).not.toBeNull();
  press(scroll);
  expect(host.querySelector(selector)).toBeNull();
});

it('更多功能面板点击框选空白区关闭，内部按下不误关', async () => {
  const { host, scroll } = mountChat({
    composerActions: { plusPanel: [{ id: 'fixture', label: '合成操作', icon: Smile }] },
  });
  await clickTitle(host, '更多功能');
  press(host.querySelector('.composer-plus-panel')!);
  expect(host.querySelector('.composer-plus-panel')).not.toBeNull();
  press(scroll);
  expect(host.querySelector('.composer-plus-panel')).toBeNull();
});

it('提及菜单点击编辑器不关闭，点击框选空白区关闭', () => {
  const { host, scroll } = mountChat();
  const editor = host.querySelector<HTMLElement>('.composer-editor')!;
  act(() => {
    editor.textContent = '@';
    focusComposerEnd(editor);
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  expect(host.querySelector('.mention-menu')).not.toBeNull();
  press(editor);
  expect(host.querySelector('.mention-menu')).not.toBeNull();
  press(scroll);
  expect(host.querySelector('.mention-menu')).toBeNull();
});

it.each([
  ['发送图片或文件', 'QQ闪传', '.flash-composer'],
  ['红包 / 礼物', '红包', '.redpacket-panel'],
  ['位置', '发送位置', '.location-card-panel'],
  ['位置', '共享位置', '.lbs-panel'],
  ['语音', 'AI 声聊', '.ai-voice-panel'],
])('点击框选空白区关闭%s中的%s面板', async (title, action, selector) => {
  const { host, scroll } = mountChat();
  await clickTitle(host, title);
  if (action === 'AI 声聊') await clickTitle(host, action);
  else await choose(action);
  const panel = host.querySelector(selector)!;
  expect(panel).not.toBeNull();
  press(panel);
  expect(host.querySelector(selector)).not.toBeNull();
  press(scroll);
  expect(host.querySelector(selector)).toBeNull();
});

it.each([
  ['发送 Ark 卡片', undefined, '.ark-panel', 'ark-contact-list'],
  ['发送图片或文件', 'QQ闪传', '.flash-composer', 'flash-lightbox'],
])('点击%s的 Portal 子面板不误关父面板', async (title, action, selector, className) => {
  const { host, scroll } = mountChat();
  await clickTitle(host, title);
  if (action) await choose(action);
  const portal = document.createElement('div');
  portal.className = className;
  document.body.append(portal);
  cleanups.push(() => portal.remove());
  press(portal);
  expect(host.querySelector(selector)).not.toBeNull();
  portal.remove();
  press(scroll);
  expect(host.querySelector(selector)).toBeNull();
});

it('请求麦克风期间点击消息空白区仍保留录音面板', async () => {
  const { host, scroll } = mountChat();
  const getUserMedia = vi.fn(() => new Promise<MediaStream>(() => {}));
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  await clickTitle(host, '语音');
  await act(async () => press(host.querySelector('[aria-label="按住说话"]')!));
  expect(getUserMedia).toHaveBeenCalledOnce();
  press(scroll);
  expect(host.querySelector('.voice-panel')).not.toBeNull();
});

it.each(['mouse', 'touch', 'pen'])('贴表情在%s外部按下被拦截冒泡时仍关闭', (pointerType) => {
  const onClose = vi.fn();
  const host = mount(h(ReactionPicker, { anchor: { x: 10, y: 10 }, onClose, onSelect: vi.fn() }));
  press(host.querySelector('.reaction-picker')!, pointerType);
  expect(onClose).not.toHaveBeenCalled();
  host.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  press(host, pointerType);
  expect(onClose).toHaveBeenCalledOnce();
});

it('搜索下拉在外部按下被阻止默认行为和冒泡时仍收起，内部按下不收起', () => {
  const dismissed = vi.fn(),
    focused = vi.fn();
  function Probe() {
    useSearchDismissal('合成搜索', true, dismissed, focused);
    return h('div', { className: 'weq-search-dropdown' });
  }
  const host = mount(h(Probe));
  press(host.firstElementChild!);
  expect(dismissed).not.toHaveBeenCalled();
  host.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  press(host);
  expect(dismissed).toHaveBeenCalledWith(true);
  expect(focused).toHaveBeenCalledWith(false);
});

function obstructOutside(host: HTMLElement) {
  host.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
}

it('导航栏个人菜单不受外部默认行为及冒泡拦截影响', () => {
  const host = mount(
    h(AppRail, {
      user: createTemplateDemoData().user,
      view: 'messages',
      onViewChange: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenCollection: vi.fn(),
      onOpenDressUp: vi.fn(),
      onOpenProfile: vi.fn(),
      onOpenAbout: vi.fn(),
      onOpenInvite: vi.fn(),
      onOpenWonderfulTools: vi.fn(),
      onOpenAntiRecall: vi.fn(),
      onOpenDbRepair: vi.fn(),
      onOpenQzoneAlbum: vi.fn(),
    }),
  );
  act(() => host.querySelector<HTMLButtonElement>('.rail-avatar')!.click());
  press(host.querySelector('.profile-popover')!);
  expect(host.querySelector('.profile-popover')).not.toBeNull();
  obstructOutside(host);
  press(host);
  expect(host.querySelector('.profile-popover')).toBeNull();
});

it('侧栏添加菜单不受外部默认行为及冒泡拦截影响', async () => {
  const host = mount(
    h(SidebarHeader, {
      user: createTemplateDemoData().user,
      view: 'messages',
      query: '',
      onQueryChange: vi.fn(),
      onOpenProfile: vi.fn(),
      onOpenFriendNotices: vi.fn(),
      onOpenGroupNotices: vi.fn(),
      contactTab: 'friends',
      onContactTabChange: vi.fn(),
      activeNotice: null,
    }),
  );
  await clickTitle(host, '搜索 QQ 号或群号');
  press(host.querySelector('.sidebar-add-menu')!);
  expect(host.querySelector('.sidebar-add-menu')).not.toBeNull();
  obstructOutside(host);
  press(host);
  expect(host.querySelector('.sidebar-add-menu')).toBeNull();
});

it('合并会话面板延迟注册外部关闭，卸载后移除捕获监听', () => {
  vi.useFakeTimers();
  try {
    const onBack = vi.fn();
    const host = mount(
      h(MergedSessionPanel, {
        kind: 'official',
        conversations: [],
        anchorX: 0,
        anchorY: 0,
        onBack,
        onSelectConversation: vi.fn(),
      }),
    );
    obstructOutside(host);
    press(host);
    expect(onBack).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    press(host.querySelector('.weq-merged-popover')!);
    expect(onBack).not.toHaveBeenCalled();
    press(host);
    expect(onBack).toHaveBeenCalledOnce();
    cleanups.pop()!();
    press(document.body);
    expect(onBack).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
