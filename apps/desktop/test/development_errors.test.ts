// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { installDevelopmentErrors } from '../src/renderer/src/lib/developmentErrors';
let stop = () => {};
afterEach(() => {
  stop();
  vi.useRealTimers();
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
