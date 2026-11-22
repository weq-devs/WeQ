import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseMaintenanceSnapshot } from '@weq/service/db-checkup';
import type { AccountForcedClosedEvent } from '../src/main/context/app_context';
import { useDatabaseMaintenanceNotifications } from '../src/renderer/src/hooks/useDatabaseMaintenanceNotifications';

const fixture = vi.hoisted(() => ({
  receive: undefined as ((snapshot: DatabaseMaintenanceSnapshot) => void) | undefined,
  health: undefined as ((event: AccountForcedClosedEvent) => void) | undefined,
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
    bootstrap: {
      onAccountForcedClosed: {
        subscribe: (_: unknown, observer: { onData: typeof fixture.health }) => {
          fixture.health = observer.onData;
          return { unsubscribe() {} };
        },
      },
    },
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
  fixture.health = undefined;
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

it('后台仅提醒已确认的损坏，深度体检只收起同源同库的横幅', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.createElement('div'));
  function Observer() {
    useDatabaseMaintenanceNotifications(null);
    return null;
  }
  const dbPath = '/fixture/profile_info.db';
  const event: AccountForcedClosedEvent = {
    reason: 'database-damaged',
    kind: 'confirmed',
    uin: '10001',
    configId: 'live',
    title: 'fixture',
    message: 'fixture',
    details: [],
    failures: [{ dbName: 'profile_info.db', dbPath, corruptedTables: ['profile'] }],
    reportPath: null,
  };
  const snapshot: DatabaseMaintenanceSnapshot = {
    id: 'checkup-test',
    uin: event.uin,
    configId: event.configId,
    state: 'waiting',
    locked: true,
    operation: {
      id: 'checkup-op',
      kind: 'checkup',
      status: 'running',
      startedAt: 1,
      elapsedMs: 1,
      totalDatabases: 1,
      completedDatabases: 1,
    },
    databases: [
      {
        dbName: 'profile_info.db',
        scanStatus: 'completed',
        deepStatus: 'completed',
        support: 'supported',
        issues: [],
        integrity: { ran: true, healthy: true, corruptedTables: [], complete: true },
        scan: {
          dbName: 'profile_info.db',
          dbPath,
          pageSize: 4096,
          pageCount: 1,
          badPages: [],
          zeroPages: [],
          trailingBytes: 0,
          usedHmac: true,
          plaintext: false,
          headerOffset: 1024,
          fileSize: 5120,
          scannedAt: 1,
          affected: [],
        },
      },
    ],
  };
  try {
    act(() => root.render(createElement(Observer)));
    fixture.health!({ ...event, kind: 'check-error' });
    expect(fixture.push).not.toHaveBeenCalled();
    fixture.health!(event);
    const notice = fixture.push.mock.calls[0]?.[0];
    expect(notice).toMatchObject({ event: 'databaseDamage' });
    fixture.toasts = [
      { id: 1, key: notice.key },
      { id: 2, key: 'other-database' },
    ];
    fixture.receive!({ ...snapshot, configId: 'backup' });
    expect(fixture.toasts.map(({ id }) => id)).toEqual([1, 2]);
    fixture.receive!(snapshot);
    expect(fixture.toasts.map(({ id }) => id)).toEqual([2]);
  } finally {
    act(() => root.unmount());
  }
});
