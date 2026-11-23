import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createWorkspaceQueryRecovery,
  subscribeWorkspaceRecovery,
} from '../src/renderer/src/lib/connectionRecovery';
import { setRemoteWorkspaceCheckPending } from '../src/renderer/src/lib/remoteWorkspaceCheck';
import { useWebConnection } from '../src/renderer/src/state/webConnection';

let visibility: DocumentVisibilityState;
const cleanup: (() => void)[] = [];
beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  useWebConnection.setState({ status: 'reconnecting', connectedBefore: true, recovery: 0 });
});
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  Reflect.deleteProperty(document, 'visibilityState');
  setRemoteWorkspaceCheckPending(false);
});

function show(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

it('工作区验证未完成时等后台恢复，同一轮的 socket 与鉴权只交付一次', async () => {
  const callback = vi.fn();
  setRemoteWorkspaceCheckPending(true);
  show('hidden');
  cleanup.push(subscribeWorkspaceRecovery(callback));
  useWebConnection.getState().connected();
  await Promise.resolve();
  expect(callback).not.toHaveBeenCalled();
  show('visible');
  await Promise.resolve();
  expect(callback).not.toHaveBeenCalled();
  setRemoteWorkspaceCheckPending(false);
  useWebConnection.getState().workspaceVerified();
  await Promise.resolve();
  expect(callback).toHaveBeenCalledOnce();
  expect(callback).toHaveBeenCalledWith(2);
  useWebConnection.getState().disconnected();
  useWebConnection.getState().connected();
  await Promise.resolve();
  expect(callback.mock.calls).toEqual([[2], [3]]);
});

it('目录独立校准，优先查询先取空位，隐藏后暂停余下读取', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchOnMount: false, retry: false } },
  });
  cleanup.push(() => client.clear());
  const calls: string[] = [];
  const add = (name: string, type = 'query') => {
    const key = [name.split('.'), { type }];
    const release = Promise.withResolvers<string>();
    client.setQueryData(key, 'old');
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () => {
        calls.push(name);
        return release.promise;
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);
    cleanup.push(unsubscribe);
    return { key, observer, release, unsubscribe };
  };

  const head = add('account.listRecentContacts');
  const history = add('account.listRecentContacts', 'infinite');
  const already = add('account.getGroupDetail');
  const ownRead = already.observer.refetch();
  const priority = ['startup.snapshot', 'bootstrap.getSettings', 'clientState.snapshot'].map(
    (name) => add(name),
  );
  const ordinary = Array.from({ length: 8 }, (_, i) => add(`account.fixture${i}`));
  const recovery = createWorkspaceQueryRecovery(client);
  cleanup.push(recovery.dispose);
  recovery.request();
  expect(calls).toEqual([
    'account.getGroupDetail',
    'startup.snapshot',
    'bootstrap.getSettings',
    'account.fixture0',
    'account.fixture1',
    'account.fixture2',
  ]);
  expect(client.getQueryState(head.key)?.isInvalidated).toBe(true);
  expect(client.getQueryState(history.key)?.isInvalidated).toBe(true);
  show('hidden');
  priority[0]!.release.resolve('fresh');
  ordinary[0]!.release.resolve('fresh');
  await vi.waitFor(() => expect(client.getQueryData(ordinary[0]!.key)).toBe('fresh'));
  expect(calls).toHaveLength(6);
  ordinary[3]!.unsubscribe();
  client.setQueryData(ordinary[4]!.key, 'verified by action');
  show('visible');
  await vi.waitFor(() => expect(calls).toContain('account.fixture5'));
  expect(calls).toContain('clientState.snapshot');
  expect(calls).not.toContain('account.fixture3');
  expect(calls).not.toContain('account.fixture4');
  expect(calls.filter((name) => name === 'account.getGroupDetail')).toHaveLength(1);
  // 剩余优先任务完成后，普通面板可用空位，不必等前面的慢面板。
  priority[1]!.release.resolve('fresh');
  priority[2]!.release.resolve('fresh');
  await vi.waitFor(() => expect(calls).toContain('account.fixture7'));
  for (const item of [...priority, ...ordinary, already]) item.release.resolve('fresh');
  await ownRead;
});
