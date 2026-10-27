import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CloneComposer } from '../src/renderer/src/views/agentlab/CloneConversation';
import { ChatBubble, inputFaceContext } from '../src/renderer/src/views/agentlab/ChatBubble';
import { jumpToGeneratedMessage } from '../src/renderer/src/views/agentlab/messageSearch';

vi.mock('../src/renderer/src/trpc/client', () => import('./browser/clone-conversation.stub'));
afterEach(() => vi.unstubAllGlobals());

function mount(element: Parameters<ReturnType<typeof createRoot>['render']>[0]) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(element));
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('克隆输入保留换行和中文候选确认，只有普通 Enter 才发送', () => {
  const send = vi.fn();
  const f = mount(
    createElement(CloneComposer, {
      inputRef: createRef(),
      value: '你好',
      onChange: vi.fn(),
      onSend: send,
      disabled: false,
      busy: false,
    }),
  );
  try {
    const editor = f.host.querySelector('textarea')!;
    for (const extra of [{ shiftKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      act(() =>
        editor.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...extra }),
        ),
      );
    }
    expect(send).not.toHaveBeenCalled();
    act(() => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(send).not.toHaveBeenCalled();
    act(() => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    act(() => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    expect(send).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});

it.each([
  { disabled: true, busy: false },
  { disabled: false, busy: true },
])('只读或生成中不开放发送 $disabled/$busy', (state) => {
  const f = mount(
    createElement(CloneComposer, {
      inputRef: createRef(),
      value: '你好',
      onChange: vi.fn(),
      onSend: vi.fn(),
      ...state,
    }),
  );
  try {
    expect(f.host.querySelector('textarea')?.disabled).toBe(true);
    expect(f.host.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(true);
  } finally {
    f.close();
  }
});

it('克隆气泡使用源好友头像和普通消息结构，右键仅提供本地操作', () => {
  const select = vi.fn();
  const f = mount(
    createElement(ChatBubble, {
      mine: false,
      name: '合成好友',
      uin: '20001',
      text: '合成正文',
      bot: true,
      conversationStyle: true,
      onSelect: select,
    }),
  );
  try {
    expect(f.host.querySelector('.message-avatar-wrap .avatar img')?.getAttribute('src')).toContain(
      '20001',
    );
    expect(f.host.querySelector('.weq-asst-avatar')).toBeNull();
    expect(f.host.querySelector('.message-avatar-wrap [aria-label="克隆体"]')).not.toBeNull();
    expect(f.host.querySelector('.message-name')).toBeNull();
    const bubble = f.host.querySelector('.message-bubble')!;
    act(() =>
      bubble.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 100 }),
      ),
    );
    const actions = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(actions.map((node) => node.textContent)).toEqual(['复制', '多选']);
    act(() => actions.find((node) => node.textContent === '多选')!.click());
    expect(select).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});

it('工具栏保留原有图标和限制提示，表情复用普通面板并在光标处插入', () => {
  const change = vi.fn();
  const f = mount(
    createElement(CloneComposer, {
      inputRef: createRef(),
      value: '开头结尾',
      onChange: change,
      onSend: vi.fn(),
      disabled: false,
      busy: false,
    }),
  );
  try {
    for (const label of ['发红包', '通话', '语音', '发送图片或文件', '发送 Ark 卡片', '位置共享']) {
      const button = f.host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
      expect(button.disabled).toBe(true);
      expect(button.title).toContain('克隆会话');
    }
    const textarea = f.host.querySelector('textarea')!;
    textarea.setSelectionRange(2, 2);
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-label="表情"]')!.click());
    const panel = f.host.querySelector('[aria-label="表情面板"]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[aria-label="商城表情"]')).toBeNull();
    act(() => panel.querySelector<HTMLButtonElement>('[title="微笑"]')!.click());
    expect(change).toHaveBeenCalledWith('开头/微笑结尾');
  } finally {
    f.close();
  }
});

it('克隆群消息显示发送者，助手仍使用独立星芒头像', () => {
  const f = mount(
    createElement(
      'div',
      null,
      createElement(ChatBubble, {
        mine: false,
        name: '合成成员',
        uin: '20001',
        text: '群消息',
        bot: true,
        conversationStyle: true,
        showSenderName: true,
      }),
      createElement(ChatBubble, { mine: false, name: 'WeQ 助手', text: '助手消息', bot: true }),
    ),
  );
  try {
    expect(f.host.querySelector('.message-name')?.textContent).toBe('合成成员');
    expect(f.host.querySelectorAll('.weq-asst-avatar')).toHaveLength(1);
  } finally {
    f.close();
  }
});

it('工具栏表情使用完整系统表而不是训练白名单，发送者自身不带克隆角标', () => {
  const f = mount(
    createElement(ChatBubble, {
      mine: true,
      name: '我',
      text: '你好/微笑',
      conversationStyle: true,
      faces: inputFaceContext(new Map([['微笑', 14]])),
    }),
  );
  try {
    expect(f.host.querySelector('.weq-inline-face')).not.toBeNull();
    expect(f.host.querySelector('[aria-label="克隆体"]')).toBeNull();
  } finally {
    f.close();
  }
});

it('搜索跳转按持久消息身份定位，重复定位仍可滚动，缺失记录不跳到别处', () => {
  const f = mount(
    createElement(
      'div',
      null,
      createElement('div', { 'data-generated-message-id': 'persistent-id' }),
    ),
  );
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  try {
    expect(jumpToGeneratedMessage(f.host, 'persistent-id')).toBe(true);
    expect(jumpToGeneratedMessage(f.host, 'persistent-id')).toBe(true);
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(jumpToGeneratedMessage(f.host, 'missing')).toBe(false);
    expect(scroll).toHaveBeenCalledTimes(2);
  } finally {
    scroll.mockRestore();
    f.close();
  }
});
