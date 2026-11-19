import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CloneUpdateButton } from '../src/renderer/src/views/agentlab/CloneUpdateButton';
import {
  dismissCloneTask,
  getCloneTasks,
  startCloneUpdate,
} from '../src/renderer/src/views/agentlab/cloneTaskStore';
import { useViewState } from '../src/renderer/src/state/view';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<void>>(),
  confirm: vi.fn(async () => true),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      refreshAgentLabFromC2c: { mutate: mocks.refresh },
      onAgentLabBuildProgress: { subscribe: () => ({ unsubscribe: vi.fn() }) },
    },
  },
}));
vi.mock('../src/renderer/src/lib/dialogUtils', () => ({
  useAppDialog: () => ({ confirm: mocks.confirm }),
}));
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const persona = { id: 'synthetic-clone', name: '合成克隆' };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  useViewState.setState({ openedUin: 'synthetic-a' });
  host = document.createElement('div');
  root = createRoot(host);
  act(() => root.render(h(CloneUpdateButton, { persona })));
});
afterEach(() => {
  act(() => root.unmount());
  for (const task of getCloneTasks()) dismissCloneTask(task.personaId);
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});
it('取消确认不更新，确认后绑定原账号与克隆 ID 并打开统一任务列表', async () => {
  const openRequest = useWorkspaceMenu.getState().taskOpenRequest;
  mocks.confirm.mockResolvedValueOnce(false);
  await act(async () => host.querySelector('button')!.click());
  expect(mocks.refresh).not.toHaveBeenCalled();
  expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(openRequest);
  let finish!: () => void;
  mocks.refresh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => host.querySelector('button')!.click());
  expect(mocks.refresh).toHaveBeenCalledWith({
    personaId: persona.id,
    expectedAccountUin: 'synthetic-a',
  });
  expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(openRequest + 1);
  expect(getCloneTasks()[0]).toMatchObject({
    personaId: persona.id,
    operation: 'update',
    status: 'running',
  });
  expect(host.querySelector('button')!.disabled).toBe(true);
  await act(async () => {
    await startCloneUpdate({ personaId: persona.id, name: persona.name });
  });
  expect(mocks.refresh).toHaveBeenCalledOnce();
  await act(async () => {
    finish();
  });
  expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(openRequest + 1);
  expect(getCloneTasks()[0]).toMatchObject({
    personaId: persona.id,
    operation: 'update',
    status: 'done',
  });
});
it('失败保留任务错误，允许再次更新', async () => {
  mocks.refresh.mockRejectedValueOnce(new Error('合成失败'));
  await act(async () => host.querySelector('button')!.click());
  expect(getCloneTasks()[0]).toMatchObject({ status: 'error', error: '合成失败' });
  expect(host.querySelector('button')!.disabled).toBe(false);
});
it('确认期间切换账号不向新账号发起更新', async () => {
  let confirm!: (result: boolean) => void;
  mocks.confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        confirm = resolve;
      }),
  );
  await act(async () => host.querySelector('button')!.click());
  await act(async () => {
    useViewState.setState({ openedUin: 'synthetic-b' });
    confirm(true);
  });
  expect(mocks.refresh).not.toHaveBeenCalled();
});
