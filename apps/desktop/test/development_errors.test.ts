// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { installDevelopmentErrors } from '../src/renderer/src/lib/developmentErrors';
let stop = () => {};
afterEach(() => stop());
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
