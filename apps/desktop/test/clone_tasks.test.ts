import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useViewState } from '../src/renderer/src/state/view';
import { CloneTasksPane } from '../src/renderer/src/views/agentlab/CloneTasksPane';
import {
  dismissCloneTask,
  getCloneTasks,
  startCloneTask,
} from '../src/renderer/src/views/agentlab/cloneTaskStore';
import type { StartCloneArgs } from '../src/renderer/src/views/agentlab/NewCloneModal';

const mocks = vi.hoisted(() => ({
  build: vi.fn(async () => {}),
  unsubscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      buildAgentLabFromC2c: { mutate: mocks.build },
      onAgentLabBuildProgress: { subscribe: () => ({ unsubscribe: mocks.unsubscribe }) },
    },
  },
}));
let dispose = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  useViewState.setState({ openedUin: 'fixture-a' });
});
afterEach(() => {
  dispose();
  dispose = () => {};
  for (const task of getCloneTasks()) dismissCloneTask(task.personaId);
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});
function args(id: string): StartCloneArgs {
  return {
    params: {
      personaId: id,
      targetUid: `u_${id}`,
      title: id,
      mode: 'private',
      models: { chat: { providerId: 'fixture', model: 'fixture' } },
    },
    meta: { name: id, uin: '', mode: 'private' },
  };
}
it('运行中任务不能移除，切换视图不影响完成，收尾后断开订阅', async () => {
  let finish = () => {};
  mocks.build.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const running = startCloneTask(args('克隆甲'));
  dismissCloneTask('克隆甲');
  expect(getCloneTasks()[0]?.status).toBe('running');
  useViewState.setState({ openedUin: 'fixture-b' });
  finish();
  await running;
  expect(getCloneTasks()[0]).toMatchObject({
    accountId: 'fixture-a',
    status: 'done',
    percent: 100,
  });
  expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  dismissCloneTask('克隆甲');
  expect(getCloneTasks()).toHaveLength(0);
});
it('统一任务列表按账号展示克隆任务，完成后可打开克隆体或移除记录', async () => {
  await startCloneTask(args('克隆甲'));
  useViewState.setState({ openedUin: 'fixture-b' });
  await startCloneTask(args('克隆乙'));
  useViewState.setState({ openedUin: 'fixture-a' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() => root.render(h(CloneTasksPane, { onOpenPersona: open })));
  expect(host.textContent).toContain('克隆甲');
  expect(host.textContent).not.toContain('克隆乙');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="查看克隆甲的克隆进度"]')!.click());
  act(() =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('查看克隆体'))!
      .click(),
  );
  expect(open).toHaveBeenCalledWith('克隆甲');
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="移除克隆甲的克隆任务"]')!.click());
  expect(host.textContent).toContain('暂无克隆任务');
  expect(getCloneTasks().map((task) => task.personaId)).toEqual(['克隆乙']);
});
