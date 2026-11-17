import { preciseTimeFormatter as eventTimeFormatter } from '@weq/time';
import type { MonitorMetric } from '@weq/service/performance';
export const labels = { off: '关闭', light: '轻量记录', full: '完整记录' } as const;
export const metricLabels: Record<MonitorMetric, string> = {
  cpuPercent: 'CPU · 整机容量',
  residentBytes: '进程驻留内存',
  heapBytes: 'JS 堆',
  externalBytes: 'JS 外部内存',
  eventLoopP95Ms: '事件循环 P95',
};
export const time = (at: number) => eventTimeFormatter.format(new Date(at));
export function valueLabel(value: number | null | undefined, metric: MonitorMetric) {
  if (value === null || value === undefined) return '不可用';
  if (metric === 'cpuPercent') return `${value.toFixed(1)}%`;
  if (metric === 'eventLoopP95Ms') return `${value.toFixed(1)} ms`;
  const [divisor, unit] =
    Math.abs(value) >= 1073741824
      ? [1073741824, 'GiB']
      : Math.abs(value) >= 1048576
        ? [1048576, 'MiB']
        : Math.abs(value) >= 1024
          ? [1024, 'KiB']
          : [1, 'B'];
  return `${(value / divisor).toFixed(divisor === 1 ? 0 : 1)} ${unit}`;
}
export const eventLabels: Record<string, string> = {
  startup: '宿主启动',
  shutdown: '正常退出',
  'sampling-gap': '采样中断',
  'sample-unavailable': '采样不可用',
  'renderer-exit': '渲染进程退出',
  'renderer-unavailable': '渲染进程不可用',
  'mode-off': '关闭记录',
  'mode-light': '轻量记录',
  'mode-full': '完整记录',
};
