// @vitest-environment node
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { developmentStartupProgress } from '../src/main/web/development_progress';

type State = { state: string; message?: string };
type Entry = Record<string, unknown>;
function fixture(early: Entry[] = []) {
  const window = Object.assign(new EventTarget(), {
    weqRemoteStartup: undefined as State | undefined,
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

it('旧壳仅需原有字符串阶段协议：补读早到资源，去重并排除 API、外站和失败响应', () => {
  const first = entry('/@vite/client', 2000);
  const f = fixture([first]);
  expect(f.reports.at(-1)).toEqual({
    state: 'loading',
    message: '正在加载网页资源（已加载 2.0 KB，1 项）',
  });
  f.notify(
    first,
    entry('/src/main.tsx?t=123', 1000000),
    entry('/src/style.css?direct', 1000),
    entry('/trpc/startup.snapshot', 9000),
    entry('/image.png', 9000),
    entry('/src/error.tsx', 500, { responseStatus: 500 }),
    entry('/src/aborted.ts', 500, { responseStatus: 0 }),
    { name: 'http://other.invalid/app.js', decodedBodySize: 9000 },
  );
  f.flush();
  expect(f.window.weqRemoteStartup).toEqual({
    state: 'loading',
    message: '正在加载网页资源（已加载 1.0 MB，3 项）',
  });
  expect(Object.keys(f.window.weqRemoteStartup!)).toEqual(['state', 'message']);
  runInNewContext(developmentStartupProgress, f.context);
  f.flush();
  expect(f.reports).toHaveLength(2);
});

it('没有大小时不编造百分比，资源加载不覆盖恢复检查，重新等待模块时可继续报告', () => {
  const f = fixture();
  expect(f.reports.at(-1)?.message).toBe('正在加载网页资源');
  f.stage({ state: 'loading', message: '正在检查恢复状态' });
  f.notify(entry('/src/dependency.ts', 5000));
  f.flush();
  expect(f.window.weqRemoteStartup?.message).toBe('正在检查恢复状态');
  f.stage({ state: 'loading', message: '正在加载界面模块' });
  f.flush();
  expect(f.window.weqRemoteStartup?.message).toContain('5.0 KB，1 项');
  expect(f.window.weqRemoteStartup?.message).not.toContain('%');
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
