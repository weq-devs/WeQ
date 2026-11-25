import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  summarizeDatabaseMaintenance,
  type DatabaseMaintenanceSnapshot,
  type DatabaseMaintenanceStatus,
} from '@weq/service/db-checkup';
import type { AccountForcedClosedEvent } from '../src/main/context/app_context';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { useDatabaseMaintenanceNotifications } from '../src/renderer/src/hooks/useDatabaseMaintenanceNotifications';

const fixture = vi.hoisted(() => ({
  receive: undefined as ((snapshot: DatabaseMaintenanceStatus) => void) | undefined,
  health: undefined as ((event: AccountForcedClosedEvent) => void) | undefined,
  focused: false,
  unsubscribe: vi.fn(),
}));
const receive = (snapshot: DatabaseMaintenanceSnapshot) =>
  fixture.receive!(summarizeDatabaseMaintenance(snapshot));
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
afterEach(() => {
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  fixture.receive = undefined;
  fixture.health = undefined;
  fixture.focused = false;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('修复进度在手动关闭后保持隐藏，聚焦后再次失焦立即恢复，聚焦时完成不补发', () => {
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
  const toast = useToast.getState();
  const banners = () => useToast.getState().toasts;
  const progressKey = 'database-maintenance-progress:focus-test';
  try {
    act(() => root.render(createElement(Observer)));
    const other = toast.push({ title: '其他通知', system: false });
    receive(snapshot);
    expect(banners()[1]).toMatchObject({ event: 'progress', loading: true });
    const progressId = banners()[1]!.id;
    toast.dismiss(progressId, 'manual');
    toast.remove(progressId);
    const next = { ...snapshot, operation: { ...snapshot.operation!, completedDatabases: 1 } };
    receive(next);
    expect(banners().map(({ id }) => id)).toEqual([other]);
    fixture.focused = true;
    popup.dispatchEvent(new Event('focus'));
    expect(banners().map(({ id }) => id)).toEqual([other]);
    fixture.focused = false;
    popup.dispatchEvent(new Event('blur'));
    expect(banners()[1]).toMatchObject({ key: progressKey, summary: '1 / 1 个数据库已完成' });
    fixture.focused = true;
    popup.dispatchEvent(new Event('focus'));
    expect(banners().map(({ id }) => id)).toEqual([other]);
    const completed = {
      ...snapshot,
      state: 'ended' as const,
      operation: { ...snapshot.operation!, status: 'completed' as const },
    };
    receive(completed);
    fixture.focused = false;
    popup.dispatchEvent(new Event('blur'));
    receive(completed);
    expect(banners().map(({ id }) => id)).toEqual([other]);
    const restarted = { ...snapshot, operation: { ...snapshot.operation!, id: 'next-operation' } };
    receive(restarted);
    expect(banners()[1]?.key).toBe(progressKey);
    const restartedId = banners()[1]!.id;
    toast.dismiss(restartedId, 'manual');
    toast.remove(restartedId);
    receive({ ...completed, operation: { ...restarted.operation, status: 'completed' } });
    expect(banners()[1]).toMatchObject({ event: 'taskComplete', loading: false });
  } finally {
    toast.resolve(progressKey);
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
    const toast = useToast.getState();
    fixture.health!({ ...event, kind: 'check-error' });
    expect(useToast.getState().toasts).toHaveLength(0);
    fixture.health!(event);
    const notice = useToast.getState().toasts[0]!;
    expect(notice).toMatchObject({ event: 'databaseDamage' });
    toast.push({ key: 'other-database', title: '其他数据库', system: false });
    receive({ ...snapshot, configId: 'backup' });
    expect(useToast.getState().leaving).toEqual([]);
    receive(snapshot);
    expect(useToast.getState().leaving).toEqual([notice.id]);
  } finally {
    act(() => root.unmount());
  }
});
