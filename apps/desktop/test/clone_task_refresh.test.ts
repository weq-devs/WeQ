import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useCloneTaskRefresh } from '../src/renderer/src/hooks/useCloneTaskRefresh';
import { useViewState } from '../src/renderer/src/state/view';
import {
  dismissCloneTask,
  getCloneTasks,
  startCloneTask,
  startCloneUpdate,
} from '../src/renderer/src/views/agentlab/cloneTaskStore';
import type { StartCloneArgs } from '../src/renderer/src/views/agentlab/NewCloneModal';
import { NewGroupModal } from '../src/renderer/src/views/agentlab/NewGroupModal';

vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/lib/draftClose', () => ({
  useDraftClose: (onClose: () => void) => ({ requestClose: onClose }),
}));

const mocks = vi.hoisted(() => ({
  build: vi.fn<() => Promise<void>>(),
  refresh: vi.fn<() => Promise<void>>(),
  invalidate: vi.fn<() => Promise<void>>(),
  utils: {
    account: {
      listAgentLabPersonas: { invalidate: () => mocks.invalidate() },
      getAgentLabPersona: { invalidate: vi.fn() },
      getAgentLabPersonaDetail: { invalidate: vi.fn() },
    },
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { useUtils: () => mocks.utils },
  client: {
    account: {
      buildAgentLabFromC2c: { mutate: mocks.build },
      refreshAgentLabFromC2c: { mutate: mocks.refresh },
      onAgentLabBuildProgress: { subscribe: () => ({ unsubscribe: vi.fn() }) },
    },
  },
}));

let queryClient: QueryClient;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let personas: string[];
const queryKey = ['synthetic-persona-directory'];
function Directory() {
  useCloneTaskRefresh();
  const query = useQuery(queryKey, async () => personas);
  return h('div', null, query.data?.join(','));
}
function GroupPicker() {
  const query = useQuery(queryKey, async () => personas);
  return h(NewGroupModal, {
    personas: (query.data ?? []).map((id) => ({ id, name: id })),
    onClose: vi.fn(),
    onCreate: vi.fn(),
  });
}
function args(id: string): StartCloneArgs {
  return {
    params: {
      personaId: id,
      targetUid: 'u_synthetic',
      models: { chat: { providerId: 'synthetic', model: 'synthetic' } },
    },
    meta: { name: id, uin: '', mode: 'private' },
  };
}
async function mount() {
  await act(async () => {
    root.render(h(QueryClientProvider, { client: queryClient }, h(Directory)));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  personas = [];
  queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, refetchOnMount: false, retry: false } },
  });
  queryClient.setQueryData(queryKey, []);
  mocks.invalidate.mockImplementation(() => queryClient.invalidateQueries({ queryKey }));
  useViewState.setState({ openedUin: 'synthetic-a' });
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  for (const task of getCloneTasks()) dismissCloneTask(task.personaId);
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});

it('会话目录所在主界面挂载刷新订阅，不依赖克隆工作区', () => {
  const main = readFileSync('src/renderer/src/views/MainView.tsx', 'utf8');
  expect(main.includes('useCloneTaskRefresh();')).toBe(true);
});

it('仅挂载会话目录时，后台创建完成也刷新已有缓存并显示克隆体', async () => {
  await mount();
  let finish = () => {};
  mocks.build.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
  let running!: Promise<void>;
  await act(async () => {
    running = startCloneTask(args('synthetic-clone'));
  });
  expect(mocks.invalidate).not.toHaveBeenCalled();
  expect(host.textContent).toBe('');
  await act(async () => {
    personas = ['synthetic-clone'];
    finish();
    await running;
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(host.textContent).toBe('synthetic-clone');
  expect(mocks.invalidate).toHaveBeenCalledOnce();
  await act(async () => {
    root.render(
      h(
        QueryClientProvider,
        { client: queryClient },
        h(Fragment, null, h(Directory), h(GroupPicker)),
      ),
    );
  });
  expect(host.querySelector('strong[title="synthetic-clone"]')).not.toBeNull();
  expect(host.textContent).not.toContain('还没有克隆体');
});

it('其他账号完成不刷新当前目录，回到所属账号时补刷', async () => {
  await mount();
  let finish = () => {};
  mocks.build.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
  let running!: Promise<void>;
  await act(async () => {
    running = startCloneTask(args('synthetic-clone'));
    useViewState.setState({ openedUin: 'synthetic-b' });
  });
  await act(async () => {
    finish();
    await running;
  });
  expect(mocks.invalidate).not.toHaveBeenCalled();
  await act(async () => useViewState.setState({ openedUin: 'synthetic-a' }));
  expect(mocks.invalidate).toHaveBeenCalledOnce();
});

it('构建失败不按成功任务刷新，离开主界面时取消订阅', async () => {
  await mount();
  mocks.build.mockRejectedValueOnce(new Error('synthetic failure'));
  await act(async () => startCloneTask(args('synthetic-failed')));
  expect(mocks.invalidate).not.toHaveBeenCalled();
  act(() => root.render(null));
  mocks.build.mockResolvedValueOnce();
  await startCloneTask(args('synthetic-background'));
  expect(mocks.invalidate).not.toHaveBeenCalled();
  await mount();
  expect(mocks.invalidate).toHaveBeenCalledOnce();
});

it('同一克隆体多次更新成功均刷新目录、画像详情与运行时缓存', async () => {
  await mount();
  mocks.refresh.mockResolvedValue(undefined);
  for (let index = 1; index <= 2; index++) {
    await act(async () => startCloneUpdate({ personaId: 'synthetic-clone', name: '合成克隆' }));
    expect(mocks.invalidate).toHaveBeenCalledTimes(index);
    expect(mocks.utils.account.getAgentLabPersona.invalidate).toHaveBeenCalledTimes(index);
    expect(mocks.utils.account.getAgentLabPersonaDetail.invalidate).toHaveBeenCalledTimes(index);
  }
});
