const windowLabels = new WeakMap<Electron.WebContents, string>();

/** Use a fixed feature name so page titles, URLs and account data stay out of history. */
export function labelPerformanceWindow(window: Electron.BrowserWindow, feature: string): void {
  windowLabels.set(window.webContents, feature);
}

export function performanceRendererLabels(
  contents: readonly Electron.WebContents[],
  main: Electron.WebContents | undefined,
): Map<number, string> {
  const labels = new Map<number, Set<string>>();
  const live = contents.filter((page) => !page.isDestroyed() && !page.isCrashed());
  const devTools = new Set(live.map((page) => page.devToolsWebContents));
  for (const page of live) {
    const pid = page.getOSProcessId();
    if (pid <= 0) continue;
    const label =
      page === main
        ? '主窗口'
        : (windowLabels.get(page) ?? (devTools.has(page) ? '开发者工具' : undefined));
    if (!label) continue;
    const features = labels.get(pid) ?? new Set<string>();
    features.add(label);
    labels.set(pid, features);
  }
  return new Map(
    Array.from(labels, ([pid, features]) => [
      pid,
      features.has('主窗口') ? '主窗口' : [...features].sort().join(' / '),
    ]),
  );
}

export function performanceUtilityLabel(metric: Electron.ProcessMetric): string {
  const service = metric.serviceName;
  const name =
    service?.match(/^[a-z][\w.]*\.mojom\.([A-Z]\w{0,79})$/)?.[1] ??
    ['Audio Service', 'Network Service', 'Storage Service', 'Video Capture'].find(
      (known) => known === metric.name,
    );
  return name ? `Utility · ${name}` : 'Utility';
}
