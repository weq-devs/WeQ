// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { captureWebWindow } from '../src/renderer/src/lib/webScreenshot';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function fixture() {
  const capture = vi.fn();
  const target = Object.assign(new EventTarget(), {
    setTimeout,
    clearTimeout,
    weqRemoteLinks: { capture },
  });
  vi.stubGlobal('window', target);
  return { target, capture };
}
it('手机截图等待对应原生回执，不把请求受理当作文件已保存', async () => {
  const { target, capture } = fixture();
  const promise = captureWebWindow();
  const id = capture.mock.calls[0]![0];
  const done = vi.fn();
  void promise.then(done);
  target.dispatchEvent(
    new CustomEvent('weq-remote-capture-result', { detail: { id: 'other', ok: true } }),
  );
  await Promise.resolve();
  expect(done).not.toHaveBeenCalled();
  target.dispatchEvent(
    new CustomEvent('weq-remote-capture-result', { detail: { id, ok: true, delivery: 'native' } }),
  );
  expect(await promise).toMatchObject({ ok: true, delivery: 'native' });
});
it('原生截图超时恢复调用方，不留下无限等待', async () => {
  vi.useFakeTimers();
  fixture();
  const pending = captureWebWindow();
  await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toMatchObject({ ok: false, error: '截图响应超时' });
  expect(vi.getTimerCount()).toBe(0);
});
