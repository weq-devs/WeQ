import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trpc, trpcClient } from '../src/renderer/src/trpc/client';
import { useGroupMemberRefresh } from '../src/renderer/src/hooks/useGroupMemberRefresh';

const state = vi.hoisted(() => ({
  status: 'running',
  revision: 0,
  statusReads: 0,
  snapshotReads: 0,
  graphReads: 0,
}));
vi.mock('../src/renderer/src/state/view', () => ({
  useViewState: Object.assign((select) => select({ openedUin: '99999' }), {
    getState: () => ({ openedUin: '99999' }),
  }),
}));
vi.mock('../src/renderer/src/state/workspaceMenu', () => ({
  useWorkspaceMenu: { getState: () => ({ focusTask() {} }) },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (select) => select({ showError() {}, confirm: async () => true }),
}));
vi.mock('../src/renderer/src/trpc/client', async () => {
  const { createTRPCReact } = await import('@trpc/react-query');
  const { observable } = await import('@trpc/server/observable');
  const trpc = createTRPCReact();
  const trpcClient = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            // 故意不发送任何订阅通知，验证查询缓存能够自行恢复。
            if (op.type === 'subscription') return () => {};
            let data: unknown;
            if (op.path === 'account.getAccountConfig')
              data = { uin: '99999', configId: 'synthetic' };
            else if (op.path === 'account.getRelationGraph') {
              state.graphReads++;
              data = { builtAt: state.revision };
            } else if (
              op.path === 'account.contactMetrics.status' ||
              op.path === 'account.contactMetrics.snapshot'
            ) {
              if (op.path.endsWith('.status')) state.statusReads++;
              else state.snapshotReads++;
              data = {
                target: 'groupMembers',
                taskId: 'synthetic-task',
                relationGraphRevision: state.revision,
                progress: { status: state.status },
              };
            } else throw new Error(`未预期的请求：${op.path}`);
            observer.next({ result: { data } });
            observer.complete();
          }),
    ],
  });
  return { trpc, trpcClient };
});

const cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.status = 'running';
  state.revision = 0;
  state.statusReads = 0;
  state.snapshotReads = 0;
  state.graphReads = 0;
});
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
  vi.unstubAllGlobals();
});

function render() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 5 * 60_000,
        refetchOnMount: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  function Fixture() {
    const refresh = useGroupMemberRefresh();
    const graph = trpc.account.getRelationGraph.useQuery(undefined);
    return h('button', { disabled: refresh.refreshing }, String(graph.data?.builtAt ?? ''));
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const mount = (visible: boolean) =>
    act(() =>
      root.render(
        h(
          trpc.Provider,
          { client: trpcClient, queryClient },
          h(QueryClientProvider, { client: queryClient }, visible ? h(Fixture) : null),
        ),
      ),
    );
  mount(true);
  cleanup.push(() => {
    act(() => root.unmount());
    queryClient.clear();
    host.remove();
  });
  return { host, mount };
}
async function until(assert: () => void) {
  for (let attempt = 0; ; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    try {
      assert();
      return;
    } catch (error) {
      if (attempt >= 45) throw error;
    }
  }
}

it('漏收完成通知后自动退出更新中，补读新图谱且终态停止轮询', async () => {
  const { host } = render();
  await until(() => expect(host.querySelector('button')?.disabled).toBe(true));
  state.status = 'completed';
  state.revision = 1;
  await until(() => {
    expect(host.querySelector('button')?.disabled).toBe(false);
    expect(host.textContent).toBe('1');
  });
  expect(state.snapshotReads).toBe(0);
  const reads = state.statusReads;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2200));
  });
  expect(state.statusReads).toBe(reads);
});

it('离开页面期间完成任务，回来不复用旧运行状态和旧图谱', async () => {
  const { host, mount } = render();
  await until(() => expect(host.querySelector('button')?.disabled).toBe(true));
  mount(false);
  state.status = 'completed';
  state.revision = 1;
  mount(true);
  await until(() => {
    expect(host.querySelector('button')?.disabled).toBe(false);
    expect(host.textContent).toBe('1');
  });
});
