import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';
import { acceptPreferences } from '../src/renderer/src/lib/clientPreferences';
import { SlashEmojiSettings } from '../src/renderer/src/components/settings/SlashEmojiSettings';
import { preferenceDefaults, validatePreferencePatch } from '@weq/service/client-preferences';

vi.mock('../src/renderer/src/trpc/client', () => {
  const catalog = {
    faces: [
      { id: '297', desc: '/拜谢', shortcuts: ['bx'] },
      { id: '182', desc: '/笑哭', shortcuts: ['xk'] },
      { id: '76', desc: '/赞', shortcuts: ['qiang', 'strong'] },
    ],
    recent: [],
  };
  const proxy = (path = ''): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: path.endsWith('shortcuts') ? catalog : undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate() {}, mutateAsync: async () => undefined, isLoading: false })
            : proxy(`${path}.${String(key)}`),
    });
  return { trpc: proxy(), client: proxy() };
});
let revision = 0;
function preferences(slashEmojiEnabled = true, slashEmojiAutoReplace = false) {
  act(() =>
    acceptPreferences(
      {
        revision: ++revision,
        values: { slashEmojiEnabled, slashEmojiAutoReplace },
        records: {},
      },
      false,
    ),
  );
}
afterEach(() => {
  preferences();
  vi.unstubAllGlobals();
});

function composer() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onDraftChange = vi.fn();
  const onSend = vi.fn(async () => {});
  act(() =>
    root.render(
      h(ChatPane, {
        user: demo.user,
        conversation: demo.conversations[0]!,
        messages: [],
        loading: false,
        draft: '',
        onDraftChange,
        onDraftClear: vi.fn(),
        onSend,
        onBack: vi.fn(),
      }),
    ),
  );
  const editor = host.querySelector<HTMLElement>('.composer-editor')!;
  const input = (text: string, offset = text.length, inputType = 'insertText') =>
    act(() => {
      editor.textContent = text;
      editor.focus();
      const range = document.createRange();
      range.setStart(editor.firstChild!, offset);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType }));
    });
  const press = (key: string) =>
    act(() =>
      editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })),
    );
  return {
    editor,
    input,
    press,
    onDraftChange,
    onSend,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('只替换光标前的斜杠片段，选择不发送，取消后不会原地重弹', () => {
  const { editor, input, press, onDraftChange, onSend, close } = composer();
  try {
    input('前文/bx后文', 5);
    expect(document.querySelector('[aria-label="表情候选"]')).not.toBeNull();
    press('Enter');
    expect(editor.querySelector('img')?.dataset.chatToken).toBe('[[chat:face:297]]');
    expect(editor.textContent).toBe('前文后文');
    expect(onDraftChange.mock.calls.at(-1)?.[1]).toBe('前文[[chat:face:297]]后文');
    input('/xk');
    press('Tab');
    expect(editor.querySelector('img')?.dataset.chatToken).toBe('[[chat:face:182]]');
    expect(onSend).not.toHaveBeenCalled();
    input('/');
    press('Escape');
    act(() =>
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(document.querySelector('[aria-label="表情候选"]')).toBeNull();
    expect(editor.textContent).toBe('/');
    input('https://example.com/笑');
    expect(document.querySelector('[aria-label="表情候选"]')).toBeNull();
    input('/strong');
    expect(document.querySelector('[role="option"] code')?.textContent).toBe('/strong');
  } finally {
    close();
  }
});

it('自动替换默认关闭，设置仅接受布尔值', () => {
  expect(preferenceDefaults.slashEmojiAutoReplace).toBe(false);
  expect(() => validatePreferencePatch({ slashEmojiAutoReplace: true })).not.toThrow();
  expect(() => validatePreferencePatch({ slashEmojiAutoReplace: 'true' })).toThrow();
});

it('开启后完整代码自动替换，前缀、撤销、输入法组合和关闭功能时不替换', () => {
  preferences(true, true);
  const { editor, input, onSend, onDraftChange, close } = composer();
  try {
    input('/str');
    expect(editor.querySelector('img')).toBeNull();
    input('前文/STRONG后文', 9);
    expect(editor.querySelector('img')?.dataset.chatToken).toBe('[[chat:face:76]]');
    expect(onDraftChange.mock.calls.at(-1)?.[1]).toBe('前文[[chat:face:76]]后文');
    input('/strong', 7, 'historyUndo');
    expect(editor.querySelector('img')).toBeNull();
    act(() =>
      editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true })),
    );
    expect(editor.querySelector('img')).toBeNull();
    act(() => editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    input('/笑哭');
    expect(editor.querySelector('img')).toBeNull();
    act(() => editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    expect(editor.querySelector('img')?.dataset.chatToken).toBe('[[chat:face:182]]');
    preferences(false, true);
    input('/bx');
    expect(editor.querySelector('img')).toBeNull();
    expect(document.querySelector('[aria-label="表情候选"]')).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  } finally {
    close();
  }
});

it('设置主开关关闭时隐藏自动替换项，开启后重新显示原值', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  preferences(false, true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(h(SlashEmojiSettings)));
    expect(host.querySelector('[data-setting-id="slash-emoji-input"]')).not.toBeNull();
    expect(host.querySelector('[data-setting-id="slash-emoji-auto-replace"]')).toBeNull();
    preferences(true, true);
    expect(
      host.querySelector('[aria-label="无需回车即自动替换"]')?.getAttribute('aria-checked'),
    ).toBe('true');
  } finally {
    act(() => root.unmount());
  }
});
