// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { installDevelopmentErrors } from '../src/renderer/src/lib/developmentErrors';
let stop = () => {};
afterEach(() => {
  stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('开发尺寸诊断保留原回调与构造语义，记录有界来源且不读取布局或正文', () => {
  let callback: ResizeObserverCallback | undefined;
  class OriginalObserver {
    constructor(cb: ResizeObserverCallback) {
      callback = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', OriginalObserver);
  const report = vi.fn();
  stop = installDevelopmentErrors(window, true, report);
  const notified = vi.fn();
  const observer = new ResizeObserver(notified);
  expect(observer).toBeInstanceOf(OriginalObserver);
  const element = document.createElement('div');
  element.className = 'fixture-size';
  element.id = 'private-id';
  element.textContent = 'private-text';
  const bounds = vi.spyOn(element, 'getBoundingClientRect');
  const entries: ResizeObserverEntry[] = [
    {
      target: element,
      contentRect: new DOMRect(0, 0, 200, 40),
      borderBoxSize: [],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    },
  ];
  for (let repeat = 0; repeat < 20; repeat++) callback!(entries, observer);
  expect(notified).toHaveBeenCalledTimes(20);
  expect(notified).toHaveBeenLastCalledWith(entries, observer);
  window.dispatchEvent(
    new ErrorEvent('error', {
      message: 'ResizeObserver loop completed with undelivered notifications.',
    }),
  );
  const context = report.mock.calls.at(-1)![2];
  expect(context.resizeCallbacks.length).toBeGreaterThan(0);
  expect(context.resizeCallbacks.length).toBeLessThanOrEqual(6);
  expect(context.resizeCallbacks.at(-1)).toMatchObject({
    targets: ['div.fixture-size 200x40'],
    sourceStack: expect.stringContaining('development_errors.test.ts'),
  });
  expect(JSON.stringify(context)).not.toContain('private-id');
  expect(JSON.stringify(context)).not.toContain('private-text');
  expect(bounds).not.toHaveBeenCalled();
  stop();
  expect(window.ResizeObserver).toBe(OriginalObserver);
  callback!(entries, observer);
  expect(notified).toHaveBeenCalledTimes(21);
});

it('正式模式不替换尺寸监听器，重装清理旧诊断且不恢复覆盖后的构造器', () => {
  const OriginalObserver = window.ResizeObserver;
  stop = installDevelopmentErrors(window, false, vi.fn());
  expect(window.ResizeObserver).toBe(OriginalObserver);
  const oldStop = installDevelopmentErrors(window, true, vi.fn());
  const oldObserver = window.ResizeObserver;
  stop = installDevelopmentErrors(window, true, vi.fn());
  expect(window.ResizeObserver).not.toBe(oldObserver);
  oldStop();
  expect(window.ResizeObserver).not.toBe(OriginalObserver);
  class LaterObserver extends OriginalObserver {}
  vi.stubGlobal('ResizeObserver', LaterObserver);
  stop();
  expect(window.ResizeObserver).toBe(LaterObserver);
});
it('只安装一套异常监听，重装和 HMR 清理不改变原异常行为', () => {
  const old = vi.fn(),
    report = vi.fn();
  const disposeOld = installDevelopmentErrors(window, true, old);
  stop = installDevelopmentErrors(window, true, report);
  disposeOld();
  const event = new ErrorEvent('error', { error: new Error('fixture'), cancelable: true });
  window.dispatchEvent(event);
  expect(old).not.toHaveBeenCalled();
  expect(report).toHaveBeenCalledTimes(1);
  expect(event.defaultPrevented).toBe(false);
  const rejection = new Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', { value: new Error('rejection') });
  window.dispatchEvent(rejection);
  expect(report).toHaveBeenCalledTimes(2);
  stop();
  window.dispatchEvent(event);
  expect(report).toHaveBeenCalledTimes(2);
});
it('正式模式不上报，上报函数抛错不影响事件分发', () => {
  const report = vi.fn();
  stop = installDevelopmentErrors(window, false, report);
  window.dispatchEvent(new ErrorEvent('error', { message: 'fixture' }));
  expect(report).not.toHaveBeenCalled();
  stop = installDevelopmentErrors(window, true, () => {
    throw new Error('bridge');
  });
  expect(() => window.dispatchEvent(new ErrorEvent('error', { message: 'fixture' }))).not.toThrow();
});

it('浏览器尺寸循环单独聚合为告警，不冒充未处理异常或吞掉原事件', () => {
  vi.useFakeTimers();
  const report = vi.fn();
  stop = installDevelopmentErrors(window, true, report);
  const message = 'ResizeObserver loop completed with undelivered notifications.';
  const fire = () => {
    const event = new ErrorEvent('error', {
      message,
      filename: 'http://localhost/scene.html',
      cancelable: true,
    });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  };
  fire();
  fire();
  fire();
  expect(report).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenLastCalledWith(
    'warn',
    '界面尺寸监听循环，部分通知延后交付',
    expect.objectContaining({ event: 'renderer-resize-observer-loop', count: 1 }),
  );
  vi.advanceTimersByTime(60_000);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith(
    'warn',
    '界面尺寸监听循环，部分通知延后交付',
    expect.objectContaining({ event: 'renderer-resize-observer-loop', count: 2 }),
  );
  fire();
  stop();
  vi.advanceTimersByTime(60_000);
  expect(report).toHaveBeenCalledTimes(3);
});

it('相同文案的真实异常、Promise 拒绝和其他无堆栈异常仍上报 error', () => {
  const report = vi.fn();
  stop = installDevelopmentErrors(window, true, report);
  const message = 'ResizeObserver loop completed with undelivered notifications.';
  window.dispatchEvent(new ErrorEvent('error', { message, error: new Error(message) }));
  window.dispatchEvent(new ErrorEvent('error', { message, filename: 'app.js', lineno: 42 }));
  window.dispatchEvent(new ErrorEvent('error', { message: 'other browser error' }));
  const rejection = new Event('unhandledrejection');
  Object.defineProperty(rejection, 'reason', { value: message });
  window.dispatchEvent(rejection);
  expect(report).toHaveBeenCalledTimes(4);
  expect(report.mock.calls.every(([level]) => level === 'error')).toBe(true);
  expect(report.mock.calls[1]?.[2]).toMatchObject({
    errorName: 'NonErrorException',
    filename: 'app.js',
    lineno: 42,
  });
  expect(report.mock.calls[3]?.[2]).toMatchObject({ errorName: 'NonErrorRejection' });
});

it('尺寸告警重装后清理聚合定时器，上报失败不影响后续异常', () => {
  vi.useFakeTimers();
  const old = vi.fn();
  stop = installDevelopmentErrors(window, true, old);
  const fire = () =>
    window.dispatchEvent(
      new ErrorEvent('error', { message: 'ResizeObserver loop limit exceeded' }),
    );
  fire();
  fire();
  const report = vi.fn();
  stop = installDevelopmentErrors(window, true, report);
  vi.advanceTimersByTime(60_000);
  expect(old).toHaveBeenCalledTimes(2);
  expect(old).toHaveBeenLastCalledWith(
    'warn',
    expect.any(String),
    expect.objectContaining({ count: 1 }),
  );
  expect(report).not.toHaveBeenCalled();
  report.mockImplementation(() => {
    throw new Error('bridge');
  });
  expect(fire).not.toThrow();
  expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('fixture') }));
  expect(report).toHaveBeenLastCalledWith('error', '前端未处理异常', expect.any(Object));
});
