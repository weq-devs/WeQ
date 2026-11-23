// @vitest-environment node
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { developmentStartupProgress } from '../src/main/web/development_progress';

type State = { state: string; message?: string };
type Entry = Record<string, unknown>;
type Progress = { completed: number; downloadedBytes: number; cached: number; unknown: number };
function fixture(early: Entry[] = [], platform?: 'ios' | 'android') {
  const progress: Progress[] = [];
  const window = Object.assign(new EventTarget(), {
    weqRemoteStartup: undefined as State | undefined,
    weqRemoteDevelopmentResources: undefined as Progress | undefined,
    webkit:
      platform === 'android'
        ? undefined
        : {
            messageHandlers: {
              weqResources: {},
              weqDevelopmentResources:
                platform === 'ios'
                  ? { postMessage: (value: Progress) => progress.push(value) }
                  : undefined,
            },
          },
    weqRemoteLinks:
      platform === 'android'
        ? { developmentResources: (value: string) => progress.push(JSON.parse(value)) }
        : undefined,
  });
  const document = new EventTarget();
  const reports: State[] = [];
  const timers = new Map<number, () => void>();
  let id = 0,
    disconnected = 0;
  let notify: (list: { getEntries: () => Entry[] }) => void = () => {};
  window.addEventListener('weq-remote-startup', () =>
    reports.push({ ...window.weqRemoteStartup! }),
  );
  const context = {
    window,
    document,
    URL,
    Event,
    Set,
    Number,
    location: { href: 'http://computer.invalid/', origin: 'http://computer.invalid' },
    performance: { getEntriesByType: () => early },
    setTimeout: (callback: () => void) => {
      timers.set(++id, callback);
      return id;
    },
    clearTimeout: (value: number) => timers.delete(value),
    PerformanceObserver: class {
      constructor(callback: typeof notify) {
        notify = callback;
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    },
  };
  runInNewContext(developmentStartupProgress, context);
  return {
    window,
    reports,
    progress,
    context,
    notify: (...entries: Entry[]) => notify({ getEntries: () => entries }),
    flush: () => {
      const jobs = [...timers.values()];
      timers.clear();
      for (const job of jobs) job();
    },
    disconnected: () => disconnected,
    stage: (state: State) => {
      window.weqRemoteStartup = state;
      window.dispatchEvent(new Event('weq-remote-startup'));
    },
  };
}
const entry = (path: string, size: number, extra: Entry = {}): Entry => ({
  name: `http://computer.invalid${path}`,
  decodedBodySize: size,
  responseStatus: 200,
  ...extra,
});

it('iPhone 状态码未知但有接收字节时仍持续报告压缩后的实际下载量', () => {
  const f = fixture();
  const compressed = entry('/src/workspace.tsx', 15_000_000, {
    encodedBodySize: 2_000_000,
    transferSize: 2_000_300,
    responseStatus: 0,
    workerStart: 0,
    startTime: 1,
    responseEnd: 10,
  });
  f.notify(compressed);
  f.flush();
  expect(f.window.weqRemoteStartup?.message).toContain('已下载 2.0 MB');
  expect(f.window.weqRemoteStartup?.message).toContain('完成 1 项');
  expect(f.window.weqRemoteStartup?.message).not.toContain('15.0 MB');
  f.stage({ state: 'loading', message: '正在检查恢复状态' });
  f.notify({ ...compressed });
  f.flush();
  expect(f.window.weqRemoteStartup?.message).toMatch(/^正在检查恢复状态/);
  expect(f.window.weqRemoteStartup?.message).toContain('已下载 2.0 MB');
  expect(f.window.weqRemoteStartup?.message).toContain('完成 1 项');
});

it('缓存不重复计为下载，失败响应不计完成，未知来源不拿解压大小冒充下载量', () => {
  const f = fixture();
  f.notify(
    entry('/src/cached.ts', 3_000_000, { encodedBodySize: 1_000_000, transferSize: 0 }),
    entry('/src/unknown.ts', 4_000_000),
    entry('/src/failure.ts', 1000, { responseStatus: 500 }),
    entry('/src/aborted.ts', 0, { responseStatus: 0 }),
  );
  f.flush();
  expect(f.window.weqRemoteStartup?.message).toContain('完成 2 项');
  expect(f.window.weqRemoteStartup?.message).toContain('缓存 1 项');
  expect(f.window.weqRemoteStartup?.message).toContain('1 项下载量待确认');
  expect(f.window.weqRemoteStartup?.message).not.toMatch(/[34]\.0 MB/);
});

it('零尺寸的明确缓存回执仍计完成，缺少网络证据的零状态不猜成缓存或下载', () => {
  const f = fixture();
  f.notify(
    entry('/src/revalidated.ts', 0, { responseStatus: 304 }),
    entry('/src/memory.ts', 0, { deliveryType: 'cache' }),
    entry('/src/no-metrics.ts', 1_000_000, { responseStatus: 0, transferSize: 0 }),
  );
  f.flush();
  expect(f.window.weqRemoteStartup?.message).toContain('完成 3 项');
  expect(f.window.weqRemoteStartup?.message).toContain('缓存 2 项');
  expect(f.window.weqRemoteStartup?.message).toContain('1 项下载量待确认');
  expect(f.window.weqRemoteStartup?.message).not.toContain('MB');
});

it('旧壳仅需原有字符串阶段协议：补读早到资源，去重并排除 API、外站和失败响应', () => {
  const first = entry('/@vite/client', 2000);
  const f = fixture([first]);
  expect(f.reports.at(-1)).toEqual({
    state: 'loading',
    message: '正在加载网页资源（完成 1 项，1 项下载量待确认）',
  });
  f.notify(
    first,
    entry('/src/main.tsx?t=123', 1000000),
    entry('/src/style.css?direct', 1000),
    entry('/trpc/startup.snapshot', 9000),
    entry('/image.png', 9000),
    entry('/src/error.tsx', 500, { responseStatus: 500 }),
    entry('/src/aborted.ts', 0, { responseStatus: 0 }),
    { name: 'http://other.invalid/app.js', decodedBodySize: 9000 },
  );
  f.flush();
  expect(f.window.weqRemoteStartup).toEqual({
    state: 'loading',
    message: '正在加载网页资源（完成 3 项，3 项下载量待确认）',
  });
  expect(Object.keys(f.window.weqRemoteStartup!)).toEqual(['state', 'message']);
  runInNewContext(developmentStartupProgress, f.context);
  f.flush();
  expect(f.reports).toHaveLength(2);
});

it('没有大小时不编造百分比，恢复检查期间仍显示资源回执并保留实际阶段标题', () => {
  const f = fixture();
  expect(f.reports.at(-1)?.message).toBe('正在加载网页资源');
  f.stage({ state: 'loading', message: '正在检查恢复状态' });
  f.notify(entry('/src/dependency.ts', 5000));
  f.flush();
  expect(f.window.weqRemoteStartup?.message).toBe(
    '正在检查恢复状态（完成 1 项，1 项下载量待确认）',
  );
  f.stage({ state: 'loading', message: '正在加载界面模块' });
  f.flush();
  expect(f.window.weqRemoteStartup?.message).toContain('正在加载界面模块（完成 1 项');
  expect(f.window.weqRemoteStartup?.message).not.toContain('%');
});

it.each(['ios', 'android'] as const)('新版 %s 只更新资源桥，不重发或改写阶段', (platform) => {
  const first = entry('/@vite/client', 2000, { responseStatus: 304 });
  const f = fixture([first], platform);
  expect(f.reports).toEqual([]);
  const initial = { completed: 1, cached: 1, downloadedBytes: 0, unknown: 0 };
  expect(f.progress).toEqual([initial]);
  const restore = { state: 'loading', message: '正在检查恢复状态' };
  f.stage(restore);
  f.notify(
    first,
    entry('/src/workspace.tsx', 5000, {
      encodedBodySize: 2000,
      transferSize: 2300,
      serverTiming: [{ name: 'weq-remote-source', description: 'network' }],
    }),
  );
  f.flush();
  const latest = { completed: 2, cached: 1, downloadedBytes: 2000, unknown: 0 };
  expect(f.window.weqRemoteStartup).toEqual(restore);
  expect(f.reports).toEqual([restore]);
  expect(f.progress).toEqual([initial, latest]);
  expect(f.window.weqRemoteDevelopmentResources).toEqual(latest);
  f.notify(entry('/src/late.ts', 2000));
  f.stage({ state: 'ready' });
  f.flush();
  expect(f.progress).toEqual([initial, latest]);
  expect(f.disconnected()).toBe(1);
});

it.each(['ready', 'error', 'action-required'])(
  '终态 %s 后不再以加载进度覆盖页面状态或 HMR',
  (state) => {
    const f = fixture();
    f.stage({ state, message: '实际页面状态' });
    const length = f.reports.length;
    f.notify(entry('/src/hot-update.tsx?t=456', 5000));
    f.flush();
    expect(f.reports).toHaveLength(length);
    expect(f.disconnected()).toBe(1);
  },
);
