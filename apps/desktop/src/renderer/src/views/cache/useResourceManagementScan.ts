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
const receiptKey = 'weq-resource-scan-v1';
type ScanReceipt = { source: ResourceSource; updatedAt: number; stats: ScanData['stats'] };

function readScanReceipt(source: ResourceSource) {
  try {
    const saved = JSON.parse(localStorage.getItem(receiptKey) ?? 'null') as ScanReceipt | null;
    if (
      saved?.source.expectedAccountUin === source.expectedAccountUin &&
      saved.source.expectedAccountConfigId === source.expectedAccountConfigId &&
      Date.now() - saved.updatedAt <= 10 * 60_000 &&
      saved.stats.every(
        (row, index) => row.key === RESOURCE_CATEGORIES[index]?.key && row.complete !== false,
      )
    )
      return saved.stats;
  } catch {
    /* 未取得本设备的扫描回执。 */
  }
  return [];
}

function writeScanReceipt(source: ResourceSource, stats: ScanData['stats']) {
  try {
    if (stats.length)
      localStorage.setItem(
        receiptKey,
        JSON.stringify({
          source,
          stats,
          updatedAt: Date.now(),
        } satisfies ScanReceipt),
      );
    else localStorage.removeItem(receiptKey);
  } catch {
    /* 本页仍可继续扫描。 */
  }
}

/** 页面扫描只反馈页内状态，不登记后台任务；隐藏时停止续扫并丢弃迟到响应。 */
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
  const completed = useRef<ScanData['stats']>([]);
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
    completed.current = binding ? readScanReceipt(binding) : [];
    setData({ ...initial(), stats: completed.current });
  }, [binding]);
  const run = useCallback(async () => {
    if (!mounted.current || !active.current || !binding || latest.current !== binding) return;
    const id = ++generation.current;
    const current = () =>
      mounted.current && active.current && generation.current === id && latest.current === binding;
    const saved = completed.current;
    setData((old) => ({ ...initial(), revision: old.revision, stats: saved }));
    try {
      for (const category of RESOURCE_CATEGORIES.slice(saved.length)) {
        if (!current()) return;
        setData((old) => ({ ...old, scanningKey: category.key }));
        const stat = await client.account.mediaResource.analyzeTree.query({
          ...binding,
          key: category.key,
        });
        if (!current()) return;
        if (stat.key !== category.key) throw new Error('资源统计目录与请求不符，请重新扫描');
        if (stat.complete === false) {
          setData((old) => ({ ...old, stats: [...old.stats, stat] }));
          throw new Error('资源目录统计不完整，请检查读取权限后重新扫描');
        }
        const stats = [...completed.current, stat];
        completed.current = stats;
        writeScanReceipt(binding, stats);
        setData((old) => ({ ...old, stats }));
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
      writeScanReceipt(binding, []);
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
    completed.current = [];
    if (binding) writeScanReceipt(binding, []);
    await run();
  }, [binding, run]);
  return binding
    ? ({ ...data, source: binding, refresh } satisfies ResourceManagementSnapshot)
    : null;
}
