import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useViewState } from '../src/renderer/src/state/view';
import { useWorkspaceMenu } from '../src/renderer/src/state/workspaceMenu';
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
  subscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      buildAgentLabFromC2c: { mutate: mocks.build },
      onAgentLabBuildProgress: {
        subscribe: (...args: unknown[]) => {
          mocks.subscribe(...args);
          return { unsubscribe: mocks.unsubscribe };
        },
      },
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
it('开始后立即登记任务并打开统一列表，切换视图不影响完成，收尾后断开订阅', async () => {
  let finish = () => {};
  mocks.build.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const openRequest = useWorkspaceMenu.getState().taskOpenRequest;
  const running = startCloneTask(args('克隆甲'));
  expect(getCloneTasks()[0]).toMatchObject({ name: '克隆甲', status: 'running' });
  expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(openRequest + 1);
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
it('流式事件不覆盖任务阶段，收尾先刷新缓冲并保留输出供失败后查看', async () => {
  let fail!: (error: Error) => void;
  mocks.build.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
  );
  const pending = startCloneTask(args('stream-fixture'));
  const handler = mocks.subscribe.mock.calls[0]![1];
  handler.onData({ personaId: 'stream-fixture', phase: '提炼画像', percent: 62 });
  handler.onData({
    personaId: 'stream-fixture',
    phase: '模型输出',
    percent: 0,
    output: {
      requestId: 'r',
      feature: '画像卡',
      model: 'fixture',
      status: 'running',
      channel: 'content',
      text: '合成片段',
    },
  });
  fail(new Error('合成错误'));
  await pending;
  expect(getCloneTasks()[0]).toMatchObject({
    status: 'error',
    phase: '提炼画像',
    percent: 62,
    outputs: [{ requestId: 'r', content: '合成片段' }],
  });
});
it('批量克隆立即全部进入列表，失败结果仍保留且不会重新打开弹窗', async () => {
  let finish!: () => void;
  let fail!: (error: Error) => void;
  mocks.build
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
  const openRequest = useWorkspaceMenu.getState().taskOpenRequest;
  const first = startCloneTask(args('batch-a'));
  const second = startCloneTask(args('batch-b'));
  expect(getCloneTasks().map((task) => [task.personaId, task.status])).toEqual([
    ['batch-a', 'running'],
    ['batch-b', 'running'],
  ]);
  expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(openRequest + 2);
  finish();
  fail(new Error('合成失败'));
  await Promise.all([first, second]);
  expect(getCloneTasks().map((task) => task.status)).toEqual(['done', 'error']);
  expect(getCloneTasks()[1]?.error).toBe('合成失败');
  expect(useWorkspaceMenu.getState().taskOpenRequest).toBe(openRequest + 2);
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
