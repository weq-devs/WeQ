import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../../trpc/client';
import { localBackgroundTasks } from '../../state/backgroundTasks';
import {
  RESOURCE_CATEGORIES,
  type ResourceManagementSnapshot,
  type ResourceSource,
} from './resourceManagement';

type ScanData = Omit<ResourceManagementSnapshot, 'source' | 'refresh'>;
const initial = (): ScanData => ({
  stats: [],
  targets: [],
  scanningKey: null,
  complete: false,
  error: null,
  revision: 0,
});

/** 融合页面只有这一轮扫描；隐藏时停止后续请求，迟到响应不能写回或续扫。 */
export function useResourceManagementScan(source: ResourceSource | null, enabled: boolean) {
  const expectedAccountUin = source?.expectedAccountUin;
  const expectedAccountConfigId = source?.expectedAccountConfigId;
  const binding = useMemo(
    () =>
      expectedAccountUin && expectedAccountConfigId
        ? { expectedAccountUin, expectedAccountConfigId }
        : null,
    [expectedAccountUin, expectedAccountConfigId],
  );
  const latest = useRef(binding);
  latest.current = binding;
  const active = useRef(enabled);
  active.current = enabled;
  const mounted = useRef(false),
    generation = useRef(0),
    needed = useRef(true);
  const [data, setData] = useState(initial);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    needed.current = true;
    setData(initial());
  }, [binding]);
  const run = useCallback(async () => {
    if (!mounted.current || !active.current || !binding || latest.current !== binding) return;
    const id = ++generation.current;
    let stopped = false;
    const taskId = localBackgroundTasks.start({
      kind: 'resource',
      name: '扫描本地资源',
      scope: { uin: binding.expectedAccountUin, configId: binding.expectedAccountConfigId },
    });
    localBackgroundTasks.setActions(taskId, [
      {
        id: 'stop',
        label: '停止后续扫描',
        run: () => {
          stopped = true;
          localBackgroundTasks.update(taskId, { statusLabel: '停止收尾中' });
        },
      },
    ]);
    const current = () =>
      !stopped &&
      mounted.current &&
      active.current &&
      generation.current === id &&
      latest.current === binding;
    let scanned = 0;
    setData((old) => ({ ...initial(), revision: old.revision }));
    try {
      for (const category of RESOURCE_CATEGORIES) {
        if (!current()) return;
        setData((old) => ({ ...old, scanningKey: category.key }));
        localBackgroundTasks.update(taskId, {
          progress: (scanned / (RESOURCE_CATEGORIES.length + 1)) * 100,
          note: `正在扫描${category.label}`,
        });
        const stat = await client.account.mediaResource.analyzeTree.query({
          ...binding,
          key: category.key,
        });
        if (!current()) return;
        if (stat.key !== category.key) throw new Error('资源统计目录与请求不符，请重新扫描');
        setData((old) => ({ ...old, stats: [...old.stats, stat] }));
        if (stat.complete === false)
          throw new Error('资源目录统计不完整，请检查读取权限后重新扫描');
        scanned++;
      }
      if (!current()) return;
      setData((old) => ({ ...old, scanningKey: 'cleanup' }));
      localBackgroundTasks.update(taskId, {
        progress: (scanned / (RESOURCE_CATEGORIES.length + 1)) * 100,
        note: '正在统计清理范围',
      });
      const targets = await client.account.resourceCleanup.listTargets.query(binding);
      if (!current()) return;
      if (targets.some((target) => target.complete === false)) {
        setData((old) => ({ ...old, targets }));
        throw new Error('清理范围统计不完整，请重新扫描后再清理');
      }
      needed.current = false;
      localBackgroundTasks.finish(taskId, 'completed', {
        note: `${RESOURCE_CATEGORIES.length} 类资源与清理范围扫描完成`,
      });
      setData((old) => ({
        ...old,
        targets,
        complete: true,
        scanningKey: null,
        revision: old.revision + 1,
      }));
    } catch (error) {
      if (current())
        localBackgroundTasks.finish(taskId, 'failed', {
          note: error instanceof Error ? error.message : String(error),
        });
      if (current())
        setData((old) => ({
          ...old,
          error: error instanceof Error ? error.message : String(error),
          complete: false,
        }));
    } finally {
      localBackgroundTasks.finish(taskId, 'cancelled', {
        note: '扫描已停止，未完成范围可重新扫描',
      });
      localBackgroundTasks.setActions(taskId, []);
      if (stopped && mounted.current && generation.current === id)
        setData((old) => ({ ...old, scanningKey: null }));
      if (current()) setData((old) => ({ ...old, scanningKey: null }));
    }
  }, [binding]);
  useEffect(() => {
    if (!enabled) {
      generation.current += 1;
      setData((old) => ({ ...old, scanningKey: null }));
    } else if (needed.current) void run();
  }, [enabled, run]);
  const refresh = useCallback(async () => {
    if (!mounted.current || latest.current !== binding) return;
    needed.current = true;
    await run();
  }, [binding, run]);
  return binding
    ? ({ ...data, source: binding, refresh } satisfies ResourceManagementSnapshot)
    : null;
}
