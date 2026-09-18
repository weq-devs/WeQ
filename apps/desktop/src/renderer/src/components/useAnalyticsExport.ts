/**
 * 「保存为图片」的生命周期（群聊 / 私聊 / 成员分析共用）。
 *
 * 交互上只有一步：点按钮 → 把这张卡片的数据交给主进程 → 它在**隐藏窗口**里渲染同一张
 * 卡片、抓成长图、弹保存框。用户眼前那张弹窗全程不动，屏幕上也不该有任何变化
 * （见 ./analyticsShot 与 main/analytics_export.ts）。
 *
 * 这里只负责三件小事：跑的时候把按钮切成转圈、防连点、把结果变成一条提示。
 */

import { useCallback, useRef, useState } from 'react';
import { exportAnalyticsCard } from './analyticsShot';
import { useToast } from './Toast';
import type { AnalyticsExportPayload } from '../../../shared/analytics_export';

export interface AnalyticsExportHandle {
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
  const inFlightRef = useRef(false);
  const [exporting, setExporting] = useState(false);

  const start = useCallback(() => {
    if (!enabled || inFlightRef.current) return;
    const payload = build();
    if (!payload) return;
    inFlightRef.current = true;
    setExporting(true);

    void (async () => {
      const result = await exportAnalyticsCard(payload);
      inFlightRef.current = false;
      setExporting(false);
      const toast = useToast.getState();
      if (result.saved) {
        toast.push({ tone: 'success', title: '长图已保存', detail: result.path });
      } else if (!result.canceled) {
        toast.push({ tone: 'error', title: '保存图片失败', detail: result.error });
      }
    })();
  }, [enabled, build]);

  return { exporting, start };
}
