import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseMaintenanceSnapshot } from '@weq/service/db-checkup';
import { useDatabaseMaintenanceNotifications } from '../src/renderer/src/hooks/useDatabaseMaintenanceNotifications';

const fixture = vi.hoisted(() => ({
  receive: undefined as ((snapshot: DatabaseMaintenanceSnapshot) => void) | undefined,
  toasts: [] as { id: number; key: string }[],
  focused: false,
  push: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    dbRepair: {
      onMaintenance: {
        subscribe: (_: unknown, observer: { onData: typeof fixture.receive }) => {
          fixture.receive = observer.onData;
          return { unsubscribe: fixture.unsubscribe };
        },
      },
    },
    bootstrap: { onAccountForcedClosed: { subscribe: () => ({ unsubscribe() {} }) } },
  },
}));
vi.mock('../src/renderer/src/components/Toast.shared', () => ({
  useToastApi: () => ({ push: fixture.push }),
  useToast: {
    getState: () => ({
      toasts: fixture.toasts,
      remove: (id: number) => {
        fixture.toasts = fixture.toasts.filter((toast) => toast.id !== id);
      },
      resolve: (key: string) => {
        fixture.toasts = fixture.toasts.filter((toast) => toast.key !== key);
      },
    }),
  },
}));

afterEach(() => {
  fixture.toasts = [];
  fixture.receive = undefined;
  fixture.focused = false;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('修复窗口失焦才推送进度，聚焦立即移除，聚焦时完成不补发；其他横幅不受影响', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const popup = new EventTarget();
  const target = Object.assign(popup, {
    closed: false,
    document: { hasFocus: () => fixture.focused },
  }) as unknown as Window;
  const host = document.createElement('div');
  const root = createRoot(host);
  function Observer() {
    useDatabaseMaintenanceNotifications(target);
    return null;
  }
  const snapshot: DatabaseMaintenanceSnapshot = {
    id: 'focus-test',
    uin: '10001',
    state: 'repairing',
    locked: true,
    databases: [],
    operation: {
      id: 'focus-op',
      kind: 'repair',
      status: 'running',
      startedAt: 1,
      elapsedMs: 1,
      totalDatabases: 1,
      completedDatabases: 0,
    },
  };
  try {
    act(() => root.render(createElement(Observer)));
    fixture.receive!(snapshot);
    expect(fixture.push).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: 'progress', loading: true }),
    );
    fixture.toasts = [
      { id: 1, key: 'database-maintenance-progress:focus-test' },
      { id: 2, key: 'other-operation' },
    ];
    fixture.focused = true;
    popup.dispatchEvent(new Event('focus'));
    expect(fixture.toasts).toEqual([{ id: 2, key: 'other-operation' }]);
    const calls = fixture.push.mock.calls.length;
    fixture.receive!(snapshot);
    const completed = {
      ...snapshot,
      state: 'ended' as const,
      operation: { ...snapshot.operation!, status: 'completed' as const },
    };
    fixture.receive!(completed);
    expect(fixture.push).toHaveBeenCalledTimes(calls);
    fixture.focused = false;
    fixture.receive!(completed);
    expect(fixture.push).toHaveBeenCalledTimes(calls);
    fixture.receive!({ ...snapshot, operation: { ...snapshot.operation!, id: 'next-operation' } });
    expect(fixture.push).toHaveBeenCalledTimes(calls + 1);
  } finally {
    act(() => root.unmount());
    expect(fixture.unsubscribe).toHaveBeenCalledOnce();
  }
});
