import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, ipcMain, webContents, type WebContents } from 'electron';
import { startRendererDiagnostics } from '../src/main/renderer_diagnostics_runtime';
import {
  DIAGNOSTIC_SAMPLE_REQUEST,
  DIAGNOSTIC_SAMPLE_RESPONSE,
  DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS,
} from '../src/shared/renderer_diagnostics';
import { DIAGNOSTIC_INTERVAL_MS } from '../src/main/renderer_diagnostics';

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: Object.assign(new EventEmitter(), { getAppMetrics: vi.fn(() => []) }),
    ipcMain: new EventEmitter(),
    webContents: { getAllWebContents: vi.fn(() => []) },
  };
});

class FakeContents extends EventEmitter {
  pid = 100;
  mainFrame = {};
  destroyed = false;
  send = vi.fn();
  constructor(
    public id: number,
    public url = 'file:///private/path',
  ) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  isCrashed() {
    return false;
  }
  getOSProcessId() {
    return this.pid;
  }
  getURL() {
    return this.url;
  }
  getType() {
    return 'window';
  }
  asContents() {
    return this as unknown as WebContents;
  }
}

let dir: string;
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-20T04:00:00Z'));
  vi.mocked(webContents.getAllWebContents).mockReturnValue([]);
  vi.mocked(app.getAppMetrics).mockReturnValue([]);
  Object.defineProperty(app, 'isPackaged', { value: false, configurable: true });
  dir = mkdtempSync(join(tmpdir(), 'weq-diagnostic-runtime-'));
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});
const rows = () =>
  readFileSync(join(dir, 'memory-diagnostics.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

describe('诊断采样生命周期', () => {
  it('开发模式独立记录十秒采样与缓存白名单，停止后不再采样', () => {
    const main = new FakeContents(1);
    vi.mocked(webContents.getAllWebContents).mockReturnValue([main.asContents()]);
    stop = startRendererDiagnostics({
      directory: dir,
      mainWebContentsId: () => 1,
      development: true,
    });
    expect(main.send).toHaveBeenLastCalledWith(DIAGNOSTIC_SAMPLE_REQUEST, 1, true);
    ipcMain.emit(DIAGNOSTIC_SAMPLE_RESPONSE, { sender: main, senderFrame: main.mainFrame }, 1, {
      development: {
        caches: { images: { count: 2, size: 1024, liveSize: 2048, url: 'secret' } },
        animations: 3,
        runningAnimations: 2,
        documentVisible: true,
        title: 'secret',
      },
    });
    expect(readdirSync(dir)).toEqual(['dev-memory-monitor']);
    const content = readFileSync(join(dir, 'dev-memory-monitor/memory-diagnostics.jsonl'), 'utf8');
    expect(content).not.toContain('secret');
    expect(JSON.parse(content.trim().split('\n').at(-1)!)).toMatchObject({
      development: {
        caches: { images: { count: 2, sizeBytes: 1024, liveSizeBytes: 2048 } },
        animations: 3,
        runningAnimations: 2,
        documentVisible: true,
      },
    });
    vi.advanceTimersByTime(DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS - 1);
    expect(main.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(main.send).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS * 10);
    expect(main.send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('打包版即使误传开发开关也仍用分钟采样，不接受开发字段', () => {
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
    const main = new FakeContents(1);
    vi.mocked(webContents.getAllWebContents).mockReturnValue([main.asContents()]);
    stop = startRendererDiagnostics({
      directory: dir,
      mainWebContentsId: () => 1,
      development: true,
    });
    expect(main.send).toHaveBeenLastCalledWith(DIAGNOSTIC_SAMPLE_REQUEST, 1);
    ipcMain.emit(DIAGNOSTIC_SAMPLE_RESPONSE, { sender: main, senderFrame: main.mainFrame }, 1, {
      development: { animations: 999 },
    });
    expect(rows().at(-1)).not.toHaveProperty('development');
    vi.advanceTimersByTime(DEVELOPMENT_DIAGNOSTIC_INTERVAL_MS);
    expect(main.send).toHaveBeenCalledTimes(1);
    expect(readdirSync(dir)).toEqual(['memory-diagnostics.jsonl']);
  });

  it('每分钟一次，不叠加请求；销毁及停止后移除所有自建监听／计时器', () => {
    const main = new FakeContents(1);
    vi.mocked(webContents.getAllWebContents).mockReturnValue([main.asContents()]);
    stop = startRendererDiagnostics({ directory: dir, mainWebContentsId: () => 1 });
    expect(main.send).toHaveBeenCalledWith(DIAGNOSTIC_SAMPLE_REQUEST, 1);
    vi.advanceTimersByTime(DIAGNOSTIC_INTERVAL_MS - 1);
    expect(main.send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(main.send).toHaveBeenCalledTimes(2);
    main.destroyed = true;
    main.emit('destroyed');
    expect(main.listenerCount('render-process-gone')).toBe(0);
    expect(main.listenerCount('dom-ready')).toBe(0);
    stop();
    const count = rows().length;
    vi.advanceTimersByTime(DIAGNOSTIC_INTERVAL_MS * 10);
    expect(rows()).toHaveLength(count);
    expect(ipcMain.listenerCount(DIAGNOSTIC_SAMPLE_RESPONSE)).toBe(0);
    expect(app.listenerCount('web-contents-created')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('只接收当前主窗口、主 frame、当前进程及序号的单次回应', () => {
    const main = new FakeContents(1);
    const other = new FakeContents(2, 'https://user.qzone.qq.com/123?token=secret');
    vi.mocked(webContents.getAllWebContents).mockReturnValue([
      main.asContents(),
      other.asContents(),
    ]);
    stop = startRendererDiagnostics({ directory: dir, mainWebContentsId: () => 1 });
    const send = (sender: FakeContents, sequence: number, frame = sender.mainFrame) =>
      ipcMain.emit(DIAGNOSTIC_SAMPLE_RESPONSE, { sender, senderFrame: frame }, sequence, {
        jsHeapUsedBytes: 900,
        token: 'secret',
      });
    send(other, 1);
    send(main, 99);
    send(main, 1, {});
    expect(rows().filter((row) => row.kind === 'renderer-details')).toHaveLength(0);
    send(main, 1);
    send(main, 1);
    expect(rows().filter((row) => row.kind === 'renderer-details')).toHaveLength(1);
    expect(JSON.stringify(rows())).not.toMatch(/secret|qzone\.qq|private/);
    vi.advanceTimersByTime(DIAGNOSTIC_INTERVAL_MS);
    main.pid++;
    send(main, 2);
    expect(rows().filter((row) => row.kind === 'renderer-details')).toHaveLength(1);
  });

  it('忽略过期回包，崩溃关联最近 PID／页面类别，导航后不继承旧回应', () => {
    const main = new FakeContents(1);
    vi.mocked(webContents.getAllWebContents).mockReturnValue([main.asContents()]);
    stop = startRendererDiagnostics({ directory: dir, mainWebContentsId: () => 1 });
    vi.advanceTimersByTime(5001);
    const reply = (sequence: number) =>
      ipcMain.emit(
        DIAGNOSTIC_SAMPLE_RESPONSE,
        { sender: main, senderFrame: main.mainFrame },
        sequence,
        {},
      );
    reply(1);
    main.emit('render-process-gone', {}, { reason: 'oom', exitCode: 7 });
    expect(rows().at(-1)).toMatchObject({
      kind: 'renderer-exit',
      category: 'main',
      pid: 100,
      reason: 'oom',
      exitCode: 7,
    });
    vi.advanceTimersByTime(DIAGNOSTIC_INTERVAL_MS);
    main.emit('dom-ready');
    reply(2);
    expect(rows().filter((row) => row.kind === 'renderer-details')).toHaveLength(0);
  });

  it('大量页面不制造无限监听或日志，关闭后容量可复用', () => {
    const contents = Array.from({ length: 100 }, (_, id) => new FakeContents(id + 1));
    vi.mocked(webContents.getAllWebContents).mockReturnValue(
      contents.map((content) => content.asContents()),
    );
    stop = startRendererDiagnostics({ directory: dir, mainWebContentsId: () => 1 });
    expect(
      contents.filter((content) => content.listenerCount('render-process-gone') > 0),
    ).toHaveLength(64);
    expect(rows()[0]).toMatchObject({ omittedPages: 36 });
    for (const content of contents.slice(0, 64)) {
      content.destroyed = true;
      content.emit('destroyed');
    }
    vi.mocked(webContents.getAllWebContents).mockReturnValue(
      contents.slice(64).map((content) => content.asContents()),
    );
    vi.advanceTimersByTime(DIAGNOSTIC_INTERVAL_MS);
    expect(
      contents.filter((content) => content.listenerCount('render-process-gone') > 0),
    ).toHaveLength(36);
    expect(readdirSync(dir)).toHaveLength(1);
  });
});
