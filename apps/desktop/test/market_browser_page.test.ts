import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MarketEmojiBrowserLightbox } from '../src/renderer/src/views/export/MarketEmojiBrowserLightbox';
import {
  WorkspaceContent,
  WorkspacePage,
  WorkspacePages,
} from '../src/renderer/src/components/WorkspacePages';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { useUtils: () => ({}) },
  client: {
    account: {
      marketEmoji: {
        searchCatalog: {
          query: vi.fn().mockResolvedValue({ entries: [], total: 0, nextCursor: null }),
        },
      },
    },
  },
}));
vi.mock('../src/renderer/src/hooks/useExportSavePolicy', () => ({
  useExportSavePolicy: () => ({
    policy: { mode: 'after' },
    settings: { isLoading: false },
    picking: false,
  }),
}));

it('商城表情使用无标签整页和整页标题栏，关闭后恢复原内容并保留报告', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function View() {
    const [open, setOpen] = useState(true);
    return h(
      WorkspacePages,
      { navigationKey: 'chat' },
      h(WorkspaceContent, null, h('input', { 'data-chat-draft': true })),
      h(WorkspacePage, { title: '已有报告', retainOnNavigate: true }, '报告内容'),
      open && h(MarketEmojiBrowserLightbox, { onClose: () => setOpen(false) }),
    );
  }
  try {
    await act(async () => root.render(h(View)));
    const page = host.querySelector('.weq-market-browser')!;
    expect(page.closest('[role="region"][aria-label="商城表情"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="内容页面"]')).toBeNull();
    expect(page.classList.contains('weq-blob-dialog')).toBe(false);
    expect(page.querySelector('header h2')?.textContent).toBe('商城表情');
    const draft = host.querySelector<HTMLInputElement>('[data-chat-draft]')!;
    draft.value = '原会话草稿';
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="关闭商城表情"]')!.click());
    expect(host.querySelector('.weq-market-browser')).toBeNull();
    expect(host.querySelector('[aria-label="内容页面"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="已有报告"]')).not.toBeNull();
    expect(draft.closest('[hidden]')).toBeNull();
    expect(draft.value).toBe('原会话草稿');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
