import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSettingsDialog } from '../src/renderer/src/components/ConversationSettingsDialog';

vi.mock('../src/renderer/src/components/WindowSurface', () => ({
  WindowSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => vi.fn(),
}));
vi.mock('../src/renderer/src/components/GroupKeywordEditor', () => ({
  GroupKeywordEditor: () => h('div', null, '关键词编辑器'),
}));
vi.mock('../src/renderer/src/components/QQConversationControls', () => ({
  QQConversationControls: () => h('div', { 'data-testid': 'qq-controls' }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({}),
    account: {
      antiRecall: {
        getStatus: { useQuery: () => ({ data: {} }) },
        setTargets: { useMutation: () => ({}) },
        setNotify: { useMutation: () => ({}) },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

describe('会话设置默认页面', () => {
  it.each(['c2c', 'group', 'dataline'] as const)('%s 打开可用的默认设置', (kind) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    act(() =>
      root.render(
        h(ConversationSettingsDialog, { kind, conv: '123', title: '测试', onClose: vi.fn() }),
      ),
    );
    expect(host.querySelector('.weq-cvs-nav-item.is-on')?.textContent).toBe(
      kind === 'dataline' ? '防撤回' : 'QQ 设置',
    );
    expect(host.querySelector('[data-testid="qq-controls"]') !== null).toBe(kind !== 'dataline');
    const protect = [...host.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')].find(
      (button) => button.textContent === '防撤回',
    )!;
    act(() => protect.click());
    expect(host.querySelector('.weq-cvs-nav-item.is-on')?.textContent).toBe('防撤回');
  });
});
