import { app, ipcMain, webContents, type IpcMainEvent, type WebContents } from 'electron';
import { join } from 'node:path';
import {
  DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS,
  DIAGNOSTIC_SAMPLE_REQUEST,
  DIAGNOSTIC_SAMPLE_RESPONSE,
  normalizeRendererSample,
  normalizeDevelopmentSample,
} from '../shared/renderer_diagnostics';
import {
  classifyDiagnosticPage,
  createDiagnosticLog,
  DIAGNOSTIC_INTERVAL_MS,
  DIAGNOSTIC_PAGE_LIMIT,
  DIAGNOSTIC_PROCESS_LIMIT,
  projectDiagnosticProcesses,
  type DiagnosticPage,
} from './renderer_diagnostics';
import { normalizeRendererExitReason } from './renderer_recovery';

export function startRendererDiagnostics(options: {
  directory: string;
  mainWebContentsId(): number | undefined;
  development?: boolean;
}): () => void {
  const development = options.development === true && !app.isPackaged;
  const log = development
    ? createDiagnosticLog(join(options.directory, 'dev-memory-monitor'), {
        maxBytes: 8 * 1024 * 1024,
        maxEntries: 8640,
      })
    : createDiagnosticLog(options.directory);
  const pages = new Map<number, DiagnosticPage & { createdAtMs: number | null; dispose(): void }>();
  let stopped = false;
  let sequence = 0;
  let pending: {
    id: number;
    sequence: number;
    pid: number;
    requestedAtMs: number;
    createdAtMs: number | null;
  } | null = null;

  const category = (contents: WebContents) =>
    classifyDiagnosticPage(
      contents.id === options.mainWebContentsId(),
      contents.getURL(),
      contents.getType(),
    );
  const track = (contents: WebContents): void => {
    if (contents.isDestroyed() || pages.has(contents.id) || pages.size >= DIAGNOSTIC_PAGE_LIMIT)
      return;
    const page = {
      id: contents.id,
      pid: contents.getOSProcessId(),
      category: category(contents),
      createdAtMs: null as number | null,
      dispose: () => {
        contents.off('render-process-gone', gone);
        contents.off('destroyed', destroyed);
        contents.off('dom-ready', refreshIdentity);
      },
    };
    const refreshIdentity = (): void => {
      if (stopped || contents.isDestroyed()) return;
      if (pending?.id === contents.id) pending = null;
      try {
        page.pid = contents.getOSProcessId();
        page.category = category(contents);
        page.createdAtMs =
          app.getAppMetrics().find((metric) => metric.pid === page.pid)?.creationTime ?? null;
      } catch {
        page.createdAtMs = null;
      }
    };
    const gone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails): void => {
      if (stopped) return;
      if (pending?.id === contents.id) pending = null;
      log.write({
        kind: 'renderer-exit',
        ts: new Date().toISOString(),
        id: page.id,
        pid: page.pid,
        createdAtMs: page.createdAtMs,
        category: page.id === options.mainWebContentsId() ? 'main' : page.category,
        reason: normalizeRendererExitReason(details.reason),
        exitCode: details.exitCode,
      });
    };
    const destroyed = (): void => {
      page.dispose();
      pages.delete(contents.id);
      if (pending?.id === contents.id) pending = null;
    };
    pages.set(contents.id, page);
    contents.on('render-process-gone', gone);
    contents.once('destroyed', destroyed);
    contents.on('dom-ready', refreshIdentity);
  };

  const sample = (): void => {
    if (stopped) return;
    try {
      const contents = webContents.getAllWebContents();
      for (const content of contents) track(content);
      const metrics = app.getAppMetrics();
      for (const content of contents) {
        const page = pages.get(content.id);
        if (!page || content.isDestroyed()) continue;
        page.pid = content.getOSProcessId();
        page.category = category(content);
        page.createdAtMs = metrics.find((metric) => metric.pid === page.pid)?.creationTime ?? null;
      }
      log.write({
        kind: 'process-sample',
        ...(development
          ? { development: true, intervalMs: DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS }
          : {}),
        ts: new Date().toISOString(),
        processes: projectDiagnosticProcesses(metrics, [...pages.values()]),
        omittedProcesses: Math.max(0, metrics.length - DIAGNOSTIC_PROCESS_LIMIT),
        omittedPages: Math.max(0, contents.length - pages.size),
        detailCoverage: {
          main: 'requested-if-alive',
          embedded: 'unavailable-no-preload',
          eventListeners: null,
        },
      });
      const main = contents.find((content) => content.id === options.mainWebContentsId());
      const page = main && pages.get(main.id);
      if (main && page && !main.isDestroyed() && !main.isCrashed() && page.pid > 0) {
        pending = {
          id: page.id,
          pid: page.pid,
          createdAtMs: page.createdAtMs,
          sequence: ++sequence,
          requestedAtMs: Date.now(),
        };
        if (development) main.send(DIAGNOSTIC_SAMPLE_REQUEST, sequence, true);
        else main.send(DIAGNOSTIC_SAMPLE_REQUEST, sequence);
      } else pending = null;
    } catch {
      // 仅记固定事件；不让异常 URL／页面内容进入诊断。
      pending = null;
      log.write({ kind: 'sample-unavailable', ts: new Date().toISOString() });
    }
  };

  const receive = (event: IpcMainEvent, requestSequence: unknown, raw: unknown): void => {
    if (
      stopped ||
      !pending ||
      requestSequence !== pending.sequence ||
      event.sender.id !== pending.id ||
      event.sender.id !== options.mainWebContentsId() ||
      event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame ||
      event.sender.getOSProcessId() !== pending.pid ||
      Date.now() - pending.requestedAtMs > 5000
    )
      return;
    const request = pending;
    pending = null;
    log.write({
      kind: 'renderer-details',
      ts: new Date().toISOString(),
      id: request.id,
      pid: request.pid,
      createdAtMs: request.createdAtMs,
      category: 'main',
      ...normalizeRendererSample(raw),
      ...(development
        ? {
            development: normalizeDevelopmentSample(
              typeof raw === 'object' && raw !== null && 'development' in raw
                ? raw.development
                : null,
            ),
          }
        : {}),
    });
  };
  const created = (_event: Electron.Event, contents: WebContents): void => track(contents);
  app.on('web-contents-created', created);
  ipcMain.on(DIAGNOSTIC_SAMPLE_RESPONSE, receive);
  const timer = setInterval(
    sample,
    development ? DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS : DIAGNOSTIC_INTERVAL_MS,
  );
  timer.unref();
  sample();
  return () => {
    stopped = true;
    clearInterval(timer);
    app.off('web-contents-created', created);
    ipcMain.off(DIAGNOSTIC_SAMPLE_RESPONSE, receive);
    for (const page of pages.values()) page.dispose();
    pages.clear();
    pending = null;
  };
}
