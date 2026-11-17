import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatMainContent } from '../src/renderer/src/im-template/template/chatMainContent';

const loaded = vi.hoisted(() => ({
  contact: vi.fn(),
  group: vi.fn(),
  groupReady: Promise.resolve(),
}));
vi.mock('../src/renderer/src/im-template/template/profilePanes', () => {
  loaded.contact();
  return {
    ContactProfilePane: () => h('div', null, '联系人占位'),
    GroupProfilePane: () => h('div', null, '群聊占位'),
    ContactProfileDialog: () => h('div', { role: 'dialog' }, '联系人资料'),
    GroupProfileDialog: () => h('div', { role: 'dialog' }, '群资料'),
  };
});
vi.mock('../src/renderer/src/components/groupProfile/GroupProfileSurface', async () => {
  loaded.group();
  await loaded.groupReady;
  return { GroupProfileSurface: () => h('div', { role: 'dialog' }, '群资料') };
});
vi.mock('../src/renderer/src/im-template/template/chatPane', () => ({ ChatPane: () => null }));
vi.mock('../src/renderer/src/im-template/template/toolsPane', () => ({
  ToolDetailPane: () => null,
}));
afterEach(() => vi.unstubAllGlobals());

it('联系人占位不加载完整资料，首次选择才加载；关闭后不保留迟到弹窗', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const props = {
    view: 'contacts' as const,
    contactOverviewOpen: false,
    onBackContact: vi.fn(),
    onBackGroup: vi.fn(),
  } as Parameters<typeof ChatMainContent>[0];
  try {
    expect(loaded.contact).not.toHaveBeenCalled();
    expect(loaded.group).not.toHaveBeenCalled();
    await act(async () => root.render(h(ChatMainContent, props)));
    expect(host.textContent).toContain('联系人');
    expect(loaded.contact).not.toHaveBeenCalled();
    expect(loaded.group).not.toHaveBeenCalled();
    const contact = { id: 'synthetic-person' } as NonNullable<typeof props.selectedContact>;
    await act(async () => root.render(h(ChatMainContent, { ...props, selectedContact: contact })));
    expect(loaded.contact).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="dialog"]')?.textContent).toBe('联系人资料');
    expect(loaded.group).not.toHaveBeenCalled();
    await act(async () => root.render(h(ChatMainContent, props)));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    const group = { id: 'synthetic-group' } as NonNullable<typeof props.selectedGroupConversation>;
    let release = () => {};
    loaded.groupReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    await act(async () =>
      root.render(h(ChatMainContent, { ...props, selectedGroupConversation: group })),
    );
    expect(loaded.group).toHaveBeenCalledOnce();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => root.render(h(ChatMainContent, props)));
    await act(async () => release());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      root.render(h(ChatMainContent, { ...props, selectedGroupConversation: group })),
    );
    expect(host.querySelector('[role="dialog"]')?.textContent).toBe('群资料');
    expect(loaded.group).toHaveBeenCalledOnce();
    await act(async () => root.render(h(ChatMainContent, props)));
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
