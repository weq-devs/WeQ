import { useContext, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { pageSnapshots } from '../lib/pageSnapshots';
import { PageDataCache } from '../lib/pageDataCache';
import { useToastApi } from './Toast.shared';
import { SnapshotContext } from './PageSnapshots.shared';

export function PageSnapshots({
  scope,
  children,
  resetOnMount = false,
}: {
  scope: string | null;
  children: ReactNode;
  resetOnMount?: boolean;
}) {
  const notificationToast = useToastApi();
  const [preparedScope, setPreparedScope] = useState<string | null>(null);
  const needsReset = Boolean(scope && resetOnMount && preparedScope !== scope);
  useLayoutEffect(() => {
    if (!scope || !needsReset) return;
    try {
      pageSnapshots.resetScope(scope);
    } catch {
      notificationToast.push({
        tone: 'error',
        title: '页面现场重置失败',
        detail: '请检查本机存储，部分页面可能仍保留上次的操作位置。',
      });
    }
    setPreparedScope(scope);
  }, [scope, needsReset, notificationToast]);
  const context = useMemo(
    () =>
      scope
        ? { key: scope, fallback: new Map<string, unknown>(), data: new PageDataCache() }
        : null,
    [scope],
  );
  // 提交后再清除旧现场，子页面在清除完成前不挂载，也不影响被取消的并发渲染。
  return (
    <SnapshotContext.Provider value={context}>
      {needsReset ? null : children}
    </SnapshotContext.Provider>
  );
}

export function PageSnapshotsFallback({ scope, children }: { scope: string; children: ReactNode }) {
  const parent = useContext(SnapshotContext);
  return parent ? children : <PageSnapshots scope={scope}>{children}</PageSnapshots>;
}

export function PageSnapshotScope({ name, children }: { name: string; children: ReactNode }) {
  const parent = useContext(SnapshotContext);
  const context = useMemo(
    () =>
      parent
        ? { key: JSON.stringify([parent.key, name]), fallback: parent.fallback, data: parent.data }
        : null,
    [parent, name],
  );
  return <SnapshotContext.Provider value={context}>{children}</SnapshotContext.Provider>;
}
