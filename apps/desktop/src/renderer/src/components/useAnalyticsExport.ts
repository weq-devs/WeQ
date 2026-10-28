/**
 * 「保存为图片」的生命周期（群聊 / 私聊 / 成员分析共用）。
 *
 * 交互上只有一步：点按钮 → 把这张卡片的数据交给主进程 → 它在**隐藏窗口**里渲染同一张
 * 卡片。位置确认后由公共任务捕获与保存，用户眼前那张弹窗全程不动
 * （见 ./analyticsShot 与 main/analytics_export.ts）。
 *
 * 这里只负责三件小事：跑的时候把按钮切成转圈、防连点、把结果变成一条提示。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { canExportAnalyticsCard, exportAnalyticsCard } from './analyticsShot';
import { useToast } from './Toast';
import type { AnalyticsExportPayload } from '../../../shared/analytics_export';
import { client } from '../trpc/client';
import { useViewState } from '../state/view';

export interface AnalyticsExportHandle {
  available: boolean;
  exporting: boolean;
  start: () => void;
}

export function useAnalyticsExport(opts: {
  /** 数据没就绪时别允许导出（否则导出窗口里只会剩骨架屏）。 */
  enabled: boolean;
  /**
   * 现取载荷：点按钮的这一刻才组装，保证拿到的是**当前**数据（不缓存、不闭包旧值）。
   * 返回 null 表示这次没法导出（例如数据被清空了），直接忽略这次点击。
   */
  build: () => AnalyticsExportPayload | null;
}): AnalyticsExportHandle {
  const { enabled, build } = opts;
  const available = canExportAnalyticsCard();
  const inFlightRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [exporting, setExporting] = useState(false);

  const start = useCallback(() => {
    if (!enabled || !available || inFlightRef.current) return;
    const payload = build();
    if (!payload) return;
    inFlightRef.current = true;
    setExporting(true);
    const account = useViewState.getState().openedUin;

    void (async () => {
      try {
        // 离屏渲染也会挂载此 hook，不能要求它拥有主窗口的查询 Provider。
        const config = await client.account.getAccountConfig.query();
        if (!mounted.current || !account || useViewState.getState().openedUin !== account) return;
        const result = await exportAnalyticsCard({
          ...payload,
          expectedAccountUin: payload.expectedAccountUin ?? account,
          expectedAccountConfigId: payload.expectedAccountConfigId ?? config?.configId,
        });
        if (!mounted.current || useViewState.getState().openedUin !== account) return;
        const current = await client.account.getAccountConfig.query();
        if (
          !mounted.current ||
          useViewState.getState().openedUin !== account ||
          current?.configId !== config?.configId
        )
          return;
        const toast = useToast.getState();
        if (result.taskId) {
          toast.push({ tone: 'info', title: '长图导出任务已创建' });
        } else if (result.saved) {
          toast.push({ tone: 'success', title: '长图已保存', detail: result.path });
        } else if (!result.canceled) {
          toast.push({ tone: 'error', title: '保存图片失败', detail: result.error });
        }
      } catch (error) {
        if (mounted.current && useViewState.getState().openedUin === account)
          useToast.getState().push({ tone: 'error', title: '保存图片失败', detail: String(error) });
      } finally {
        inFlightRef.current = false;
        if (mounted.current) setExporting(false);
      }
    })();
  }, [enabled, available, build]);

  return { available, exporting, start };
}
