import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { client } from '../../trpc/client';
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
    const current = () =>
      mounted.current && active.current && generation.current === id && latest.current === binding;
    setData((old) => ({ ...initial(), revision: old.revision }));
    try {
      for (const category of RESOURCE_CATEGORIES) {
        if (!current()) return;
        setData((old) => ({ ...old, scanningKey: category.key }));
        const stat = await client.account.mediaResource.analyzeTree.query({
          ...binding,
          key: category.key,
        });
        if (!current()) return;
        if (stat.key !== category.key) throw new Error('资源统计目录与请求不符，请重新扫描');
        setData((old) => ({ ...old, stats: [...old.stats, stat] }));
        if (stat.complete === false)
          throw new Error('资源目录统计不完整，请检查读取权限后重新扫描');
      }
      if (!current()) return;
      setData((old) => ({ ...old, scanningKey: 'cleanup' }));
      const targets = await client.account.resourceCleanup.listTargets.query(binding);
      if (!current()) return;
      if (targets.some((target) => target.complete === false)) {
        setData((old) => ({ ...old, targets }));
        throw new Error('清理范围统计不完整，请重新扫描后再清理');
      }
      needed.current = false;
      setData((old) => ({
        ...old,
        targets,
        complete: true,
        scanningKey: null,
        revision: old.revision + 1,
      }));
    } catch (error) {
      if (current())
        setData((old) => ({
          ...old,
          error: error instanceof Error ? error.message : String(error),
          complete: false,
        }));
    } finally {
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
