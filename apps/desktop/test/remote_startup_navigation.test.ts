import { act, createElement as h, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PageSnapshots, usePageState } from '../src/renderer/src/components/PageSnapshots';
import { pageSnapshots, pageValue } from '../src/renderer/src/lib/pageSnapshots';
import {
  noopChatShellHistoryAdapter,
  useChatShellController,
} from '../src/renderer/src/im-template/template/shellController';
import type { Conversation } from '../src/renderer/src/im-template/template/types';

const scope = JSON.stringify(['10001', 'phone-account']);
const otherScope = JSON.stringify(['10002', 'other-account']);
const key = (scope: string, field: string) => JSON.stringify([scope, field]);
const conversation: Conversation = {
  id: 'c2c:u_fixture',
  type: 'direct',
  updatedAt: '',
  lastMessage: null,
  otherUser: {
    id: 'u_fixture',
    identityLabel: 'QQ',
    identityValue: '10003',
    username: '合成好友',
    displayName: '合成好友',
    avatarUrl: null,
  },
  group: null,
  members: [],
};
const history = {
  ...noopChatShellHistoryAdapter,
  isMobileShell: () => true,
  shouldAutoSelectConversation: () => false,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let shell: ReturnType<typeof useChatShellController>;
let commits: string[];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media) => Object.assign(new EventTarget(), { matches: true, media }) as MediaQueryList,
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  commits = [];
  pageSnapshots.write(key(scope, 'shell:view'), 'messages');
  pageSnapshots.write(key(scope, 'shell:conversation'), conversation.id);
  pageSnapshots.write(key(scope, 'shell:query'), '旧搜索');
  pageSnapshots.write(key(scope, 'reading'), 120);
  pageSnapshots.write(key(scope, 'draft'), '未发送草稿', true);
  pageSnapshots.write(key(otherScope, 'shell:view'), 'qzone');
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function Workspace({
  startupView,
  available = true,
}: {
  startupView: 'home' | 'messages' | null;
  available?: boolean;
}) {
  shell = useChatShellController({
    conversations: available ? [conversation] : [],
    contacts: [],
    conversationPrefs: {},
    initialActiveConversationId: null,
    initialView: 'messages',
    startupView,
    sidebarWidthStorageKey: 'fixture-sidebar',
    history,
  });
  const [reading] = usePageState('reading', 0, pageValue.number);
  const [draft] = usePageState('draft', '', pageValue.string, true);
  useLayoutEffect(() => {
    commits.push(shell.view);
  });
  return h(
    'output',
    null,
    JSON.stringify({
      view: shell.view,
      detail: shell.mainOpen,
      query: shell.query,
      reading,
      draft,
    }),
  );
}
function render(startupView: 'home' | 'messages' | null, available = true) {
  act(() =>
    root.render(
      h(
        PageSnapshots,
        { scope, resetOnMount: startupView !== null },
        h(Workspace, { startupView, available }),
      ),
    ),
  );
  return JSON.parse(host.textContent!);
}

it.each(['home', 'messages'] as const)(
  '%s 从首次提交即落在指定栏目，不打开旧会话或清除草稿',
  (page) => {
    expect(render(page)).toEqual({
      view: page,
      detail: false,
      query: '',
      reading: 0,
      draft: '未发送草稿',
    });
    expect(commits.length).toBeGreaterThan(0);
    // 首帧就必须是目标栏目：不接受"先渲染 initialView、再 effect 纠正"，那会闪一下消息页。
    expect(commits[0]).toBe(page);
    expect(commits.every((view) => view === page)).toBe(true);
    // 启动落位不得顺带打开上次会话、也不得清掉未发送的草稿。
    expect(shell.activeConversationId).toBeNull();
    // 启动落位不清草稿；别的账号的现场也不能被顺手清掉（下方断言）。
    expect(pageSnapshots.read(key(scope, 'draft'), pageValue.string, true)).toBe('未发送草稿');
    expect(pageSnapshots.read(key(otherScope, 'shell:view'), pageValue.string)).toBe('qzone');
  },
);

it('上次页面恢复本机账号的会话、查询和登记的阅读现场', () => {
  expect(render(null)).toEqual({
    view: 'messages',
    detail: true,
    query: '旧搜索',
    reading: 120,
    draft: '未发送草稿',
  });
  expect(shell.activeConversationId).toBe(conversation.id);
});

it('上次会话不在当前目录时回退列表，目录异步到达后仍可恢复会话', () => {
  expect(render(null, false).detail).toBe(false);
  expect(render(null).detail).toBe(true);
});

it('启动后进入其他页面，后台返回或网络恢复不再次应用启动页', () => {
  render('messages');
  act(() => shell.switchView('qzone'));
  act(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  expect(render('messages').view).toBe('qzone');
});
