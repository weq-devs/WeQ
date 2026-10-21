import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { expect, it, vi } from 'vitest';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import { GroupTodos } from '../src/renderer/src/components/qq-actions/GroupActions';
import { WorkspaceContent, WorkspacePages } from '../src/renderer/src/components/WorkspacePages';
import { useViewState } from '../src/renderer/src/state/view';

vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
    available: false,
    busy: false,
    result: null,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data:
                path.at(-1) === 'getAccountConfig'
                  ? { uin: '10001', configId: 'source-a' }
                  : path.at(-1) === 'todoLocalList'
                    ? [{ sequence: '123', text: '待办详情正文' }]
                    : path.at(-1) === 'todoList'
                      ? []
                      : undefined,
              isLoading: false,
              isFetching: false,
            })
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), isLoading: false })
            : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});

it('群待办附属页打开后隐藏而不卸载宿主，详情持续可见并能关闭返回', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  useViewState.setState({ openedUin: '10001' });
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((item) => item.type === 'group')!;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const moreMembers = vi.fn();
  try {
    await act(async () =>
      root.render(
        h(
          WorkspacePages,
          { navigationKey: 'group' },
          h(
            WorkspaceContent,
            null,
            h(ChatPane, {
              user: demo.user,
              conversation,
              messages: [],
              loading: false,
              draft: '',
              onBack: vi.fn(),
              onLoadMoreGroupMembers: moreMembers,
              groupTodos: h(GroupTodos, { groupId: 123, groupName: '合成群', embedded: true }),
            }),
          ),
        ),
      ),
    );
    const sidebar = host.querySelector<HTMLElement>('.group-info-panel')!;
    expect(sidebar.hidden).toBe(false);
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="查看群待办"]')!.click(),
    );
    expect(host.querySelector('.group-info-panel')).toBe(sidebar);
    expect(sidebar.hidden).toBe(true);
    const page = host.querySelector('.weq-workspace-sidecar-host [aria-label="群待办列表"]');
    expect(page).not.toBeNull();
    expect(page?.textContent).toContain('待办详情正文');
    moreMembers.mockClear();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(moreMembers).not.toHaveBeenCalled();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="关闭群待办"]')!.click(),
    );
    expect(sidebar.hidden).toBe(false);
    expect(host.querySelector('[aria-label="群待办列表"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
    useViewState.setState({ openedUin: null });
    vi.unstubAllGlobals();
  }
});
