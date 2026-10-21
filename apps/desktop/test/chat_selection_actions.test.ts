import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { ConversationSettingsDialog } from '../src/renderer/src/components/ConversationSettingsDialog';
import {
  ContentSelectionProvider,
  useContentMultiSelect,
  useContentAnalysisRequest,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';

vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (): unknown =>
    new Proxy(() => proxy(), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({ data: undefined, isLoading: false })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy(),
    });
  return { trpc: proxy(), client: proxy() };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function snapshot(name: string) {
  const output = process.env.WEQ_CHAT_LAYOUT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  const css = [
    'styles/index.css',
    'im-template/styles.css',
    'im-template/styles/chat.css',
    'styles/conversation-actions.css',
    'styles/conversation-settings.css',
    'styles/window-surface.css',
    'styles/workspace-surfaces.css',
    'styles/message-marquee.css',
    'styles/message-selection-toolbar.css',
  ]
    .map((file) => readFileSync(resolve('src/renderer/src', file), 'utf8'))
    .join('\n');
  writeFileSync(
    resolve(output, `${name}.html`),
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}</style><style>html,body{margin:0;width:100%;height:100%;font-family:system-ui}body>div:first-of-type{height:100%}.chat-pane{width:100%;height:100%}*,*::before,*::after{box-sizing:border-box}</style><body>${document.body.innerHTML}</body></html>`,
  );
}

it('多选菜单合并复制和转发，分析与导出携带精确 ID，设置使用原位窗格', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const demo = createTemplateDemoData();
  const original = demo.conversations.find((item) => item.type === 'group')!;
  if (original.type !== 'group') throw new Error('缺少合成群聊');
  const conversation = {
    ...original,
    id: '777',
    group: { ...original.group, id: '777', name: '合成测试群' },
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe() {
    const selection = useContentMultiSelect({ kind: 'messages', container: 'group:777' });
    const analysis = useContentAnalysisRequest(),
      exported = useContentExportRequest();
    return h(
      'div',
      null,
      h(
        'button',
        {
          'data-select-fixture': true,
          onClick: () => selection.setSelectedIds(new Set(['1', '3'])),
        },
        '合成选择',
      ),
      h('output', { 'data-analysis': true }, JSON.stringify(analysis)),
      h('output', { 'data-export': true }, JSON.stringify(exported)),
    );
  }
  const click = (selector: string) =>
    act(() => document.querySelector<HTMLButtonElement>(selector)!.click());
  try {
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(ChatPane, {
            user: demo.user,
            conversation,
            messages: ['1', '3'].map((id) => ({
              ...demo.messages[0]!,
              id,
              conversationId: '777',
              body: `测试消息 ${id}`,
              qqElements: [{ type: 'text', data: { textContent: `测试消息 ${id}` } }],
            })),
            loading: false,
            draft: '',
            onSend: vi.fn(),
            onDraftChange: vi.fn(),
            onDraftClear: vi.fn(),
            onBack: vi.fn(),
            onForwardMessages: vi.fn(),
          }),
          h(Probe),
        ),
      ),
    );
    click('[data-select-fixture]');
    expect(host.querySelectorAll('.selection-bar [aria-label="复制"]')).toHaveLength(1);
    expect(host.querySelectorAll('.selection-bar [aria-label="转发"]')).toHaveLength(1);
    expect(host.querySelector('.selection-bar [aria-label="复制纯文本"]')).toBeNull();
    click('[aria-label="复制"]');
    expect(document.querySelector('[role="menu"][aria-label="复制格式"]')?.textContent).toBe(
      '纯文本富文本JSON',
    );
    snapshot('copy-menu');
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.activeElement?.getAttribute('aria-label')).toBe('复制');
    click('[aria-label="转发"]');
    expect(document.querySelector('[role="menu"][aria-label="转发方式"]')?.textContent).toBe(
      '合并转发逐条转发',
    );
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    click('[aria-label="分析所选消息"]');
    expect(JSON.parse(host.querySelector('[data-analysis]')!.textContent!)).toMatchObject({
      target: { kind: 'group', groupCode: '777' },
      messageIds: ['1', '3'],
    });
    click('[aria-label="导出所选消息"]');
    expect(JSON.parse(host.querySelector('[data-export]')!.textContent!)).toMatchObject({
      selection: { scope: { type: 'items', ids: ['1', '3'] } },
    });
    act(() =>
      root.render(
        h(ConversationSettingsDialog, {
          kind: 'group',
          conv: '777',
          title: '合成测试群',
          anchor: host,
          onClose: vi.fn(),
        }),
      ),
    );
    expect(document.querySelector('.weq-conversation-settings-pane.is-anchored')).not.toBeNull();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    snapshot('conversation-settings');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
