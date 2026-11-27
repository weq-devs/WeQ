import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import type { TRPCLink } from '@trpc/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppRouter } from '../src/shared/router';
import type { BackgroundTask } from '../src/shared/background_task';
import { BackgroundTaskDetails } from '../src/renderer/src/components/tasks/BackgroundTaskDetails';
import { FlashTaskLog } from '../src/renderer/src/components/tasks/FlashTaskLog';
import { PageSnapshots } from '../src/renderer/src/components/PageSnapshots';
import { createQueryClient } from '../src/renderer/src/trpc/queryClient';
import { trpc, trpcClient } from '../src/renderer/src/trpc/client';

const fixture = vi.hoisted(() => ({
  requests: [] as { path: string; resolve: (value: unknown) => void }[],
}));
vi.mock('@transport', async () => {
  const { observable } = await import('@trpc/server/observable');
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) =>
      observable((observer) => {
        fixture.requests.push({
          path: op.path,
          resolve: (data) => {
            observer.next({ result: { data } });
            observer.complete();
          },
        });
      });
  return { createLinks: () => [link] };
});

afterEach(() => {
  vi.unstubAllGlobals();
  fixture.requests = [];
});

it.each(['background', 'flash'] as const)(
  '%s 任务重开立即显示缓存，后台刷新且不同数据源不混用',
  async (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const queryClient = createQueryClient(false);
    const host = document.createElement('div');
    const root = createRoot(host);
    const task: BackgroundTask = {
      id: 'synthetic-task',
      kind: 'model',
      name: '合成任务',
      status: 'completed',
      actions: [],
      startedAt: 1,
      updatedAt: 2,
    };
    const render = (open: boolean, configId = 'live', revision = 1) =>
      act(() =>
        root.render(
          h(
            trpc.Provider,
            { client: trpcClient, queryClient },
            h(
              QueryClientProvider,
              { client: queryClient },
              h(
                PageSnapshots,
                { scope: 'synthetic' },
                open
                  ? kind === 'background'
                    ? h(BackgroundTaskDetails, {
                        entry: { source: 'host', task: { ...task, updatedAt: revision } },
                        scope: { uin: 'synthetic', configId },
                        refresh: async () => {},
                        managementActions: [],
                        archived: false,
                      })
                    : h(FlashTaskLog, {
                        key: configId,
                        taskId: task.id,
                        version: revision,
                        binding: {
                          expectedAccountUin: 'synthetic',
                          expectedAccountConfigId: configId,
                        },
                      })
                  : null,
              ),
            ),
          ),
        ),
      );
    const finish = async (text: string) => {
      await act(async () => {
        for (const request of fixture.requests.splice(0)) {
          request.resolve(
            request.path === 'backgroundTasks.details'
              ? [`详情：${text}`]
              : [{ ts: 1, seq: 1, stage: 'task', level: 'info', text }],
          );
        }
        await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
      });
    };
    try {
      render(true);
      await finish('第一次读取的日志');
      expect(host.textContent).toContain('第一次读取的日志');
      render(false);
      // 确保已经过卸载后的缓存回收时机，再检查重开的同步提交。
      await new Promise((resolve) => setTimeout(resolve, 10));
      render(true);
      expect(host.textContent).toContain('第一次读取的日志');
      expect(host.textContent).not.toContain('读取中');
      if (kind === 'background') expect(host.textContent).toContain('详情：第一次读取的日志');
      expect(fixture.requests).toHaveLength(kind === 'background' ? 2 : 1);
      await finish('后台更新后的日志');
      expect(host.textContent).toContain('后台更新后的日志');
      expect(host.textContent).not.toContain('第一次读取的日志');
      render(false);
      await new Promise((resolve) => setTimeout(resolve, 10));
      render(true, 'live', 2);
      expect(host.textContent).toContain('后台更新后的日志');
      expect(host.textContent).not.toContain('读取中');
      await finish('新版本的日志');
      expect(host.textContent).toContain('新版本的日志');
      render(false);
      render(true, 'backup');
      expect(host.textContent).not.toContain('新版本的日志');
      await finish('另一数据源的日志');
      expect(host.textContent).toContain('另一数据源的日志');
    } finally {
      act(() => root.unmount());
      queryClient.clear();
    }
  },
);
