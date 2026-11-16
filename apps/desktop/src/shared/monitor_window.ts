export const MONITOR_WINDOWS = {
  performance: {
    name: 'weq-performance-monitor',
    title: 'WeQ · 性能监视',
    width: 1060,
    height: 740,
    minWidth: 720,
    minHeight: 520,
  },
  logs: {
    name: 'weq-log-viewer',
    title: 'WeQ · 日志查看',
    width: 960,
    height: 680,
    minWidth: 640,
    minHeight: 480,
  },
} as const;
export type MonitorTab = keyof typeof MONITOR_WINDOWS;
