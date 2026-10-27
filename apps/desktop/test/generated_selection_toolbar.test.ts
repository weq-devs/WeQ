import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import {
  cloneChatUser,
  cloneChatConversation,
  cloneChatMessages,
} from '../src/renderer/src/views/agentlab/cloneChatAdapter';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';

const copied = vi.hoisted(() => vi.fn(async (_value: string) => true));
vi.mock('../src/renderer/src/im-template/template/clipboard', () => ({
  copyTextToClipboard: copied,
}));
vi.mock('../src/renderer/src/trpc/client', () => import('./browser/clone-conversation.stub'));
afterEach(() => {
  copied.mockClear();
  vi.unstubAllGlobals();
});
const messages = [
  { id: 'a', text: '第一条' },
  { id: 'b', text: '第二条' },
  { id: 'c', text: '未选消息' },
];

it.each(['persona', 'group'] as const)('%s 多选保留普通会话的全部常规动作，未适配置灰', (kind) => {
  const f = mount(kind);
  try {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="模拟消息右键多选"]')!.click());
    act(() =>
      f.host.querySelector<HTMLButtonElement>('.message-context-menu [title="多选"]')!.click(),
    );
    const buttons = [...f.host.querySelectorAll<HTMLButtonElement>('.selection-bar button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '分析所选消息',
      '导出所选消息',
      '添加到素材库',
      '转发',
      '复制',
      '撤回所选消息',
      '删除',
      '退出多选',
    ]);
    for (const button of buttons) {
      const unsupported = ['分析所选消息', '添加到素材库', '转发', '撤回所选消息', '删除'].includes(
        button.getAttribute('aria-label')!,
      );
      expect(button.disabled).toBe(unsupported);
      if (unsupported) expect(button.title).toBe('克隆会话暂不支持此功能');
    }
    act(() => {
      for (const button of buttons) {
        if (button.disabled) button.click();
      }
    });
    expect(f.host.querySelector('[role="menu"]')).toBeNull();
    expect(f.host.querySelector('output')!.textContent).toBe('null');
  } finally {
    f.close();
  }
});

function mount(kind: 'persona' | 'group') {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture({ rows }: { rows: typeof messages }) {
    const user = cloneChatUser('self', '我', '10000');
    const peer = cloneChatUser('owner', '合成好友', '20001', true);
    const conversation = cloneChatConversation({
      target: { kind, ownerId: 'owner', sessionId: 'session' },
      viewId: 'virtual:clone:fixture',
      name: peer.displayName,
      peer,
      members: [user, peer],
    });
    const request = useContentExportRequest();
    return h(
      'div',
      null,
      h(
        'button',
        {
          'aria-label': '模拟消息右键多选',
          onClick: () => {
            host
              .querySelector('[data-message-id="b"] .message-bubble')!
              .dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
              );
          },
        },
        '多选',
      ),
      h(ChatPane, {
        user,
        conversation,
        messages: cloneChatMessages(
          rows.map((row) => ({ ...row, ts: 1 })),
          conversation.id,
          () => peer,
        ),
        loading: false,
        preference: undefined,
        draft: '',
        onDraftChange: vi.fn(),
        onDraftClear: vi.fn(),
        onSend: async () => {},
        onBack: vi.fn(),
      }),
      h('output', null, JSON.stringify(request?.selection ?? null)),
    );
  }
  const render = (rows = messages) =>
    act(() => root.render(h(ContentSelectionProvider, null, h(Fixture, { rows }))));
  render();
  return {
    host,
    render,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it.each(['persona', 'group'] as const)(
  '%s 底部操作栏按时间线顺序复制和精确导出，不扩大成整场会话',
  async (kind) => {
    const f = mount(kind);
    try {
      act(() =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="模拟消息右键多选"]')!.click(),
      );
      act(() =>
        f.host.querySelector<HTMLButtonElement>('.message-context-menu [title="多选"]')!.click(),
      );
      act(() => f.host.querySelector<HTMLElement>('[data-message-id="a"]')!.click());
      expect(f.host.querySelector('.selection-bar-info')?.getAttribute('aria-label')).toBe(
        '已选 2 条消息',
      );
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="复制"]')!.click(),
      );
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((item) => item.textContent === '纯文本')!
          .click(),
      );
      const text = copied.mock.calls.at(-1)?.[0] ?? '';
      expect(text).toContain('第一条');
      expect(text).toContain('第二条');
      expect(text).not.toContain('未选消息');
      expect(text.indexOf('第一条')).toBeLessThan(text.indexOf('第二条'));
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[aria-label="导出所选消息"]')!.click(),
      );
      expect(JSON.parse(f.host.querySelector('output')!.textContent!)).toEqual({
        owner: { kind: 'clone-messages', container: JSON.stringify([kind, 'owner', 'session']) },
        scope: { type: 'items', ids: ['a', 'b'] },
      });
      act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="退出多选"]')!.click());
      expect(f.host.querySelector('.selection-bar')).toBeNull();
    } finally {
      f.close();
    }
  },
);

it('共用正常会话的选区缓存，窗口变化仍按真实身份导出，Escape 可退出', async () => {
  const f = mount('persona');
  try {
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="模拟消息右键多选"]')!.click());
    act(() =>
      f.host.querySelector<HTMLButtonElement>('.message-context-menu [title="多选"]')!.click(),
    );
    f.render([]);
    const exportButton = f.host.querySelector<HTMLButtonElement>('[aria-label="导出所选消息"]')!;
    expect(exportButton.disabled).toBe(false);
    await act(async () => exportButton.click());
    expect(JSON.parse(f.host.querySelector('output')!.textContent!).scope).toEqual({
      type: 'items',
      ids: ['b'],
    });
    act(() =>
      f.host
        .querySelector('.chat-pane')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(f.host.querySelector('.selection-bar')).toBeNull();
  } finally {
    f.close();
  }
});
