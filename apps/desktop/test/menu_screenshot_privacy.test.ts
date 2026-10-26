import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { captureMenuScreenshot } from '../src/renderer/src/lib/menuScreenshot';
import {
  usePrivacyStore,
  PRIVACY_STORAGE_KEY,
  CAPTURE_PRIVACY_STORAGE_KEY,
} from '../src/renderer/src/state/privacy';
import {
  applyWeqClientSettings,
  snapshotWeqClientSettings,
  validateWeqClientSettings,
} from '@weq/service/backup-client';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
beforeEach(() => {
  vi.stubGlobal('localStorage', new Storage());
  vi.useFakeTimers();
  frames = new Map();
  nextFrame = 1;
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = nextFrame++;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
    frames.delete(id);
  });
  localStorage.clear();
  usePrivacyStore.getState().hydrate();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  usePrivacyStore.getState().hydrate();
  vi.unstubAllGlobals();
});
async function paint() {
  const current = [...frames.values()];
  frames.clear();
  for (const callback of current) callback(0);
  await Promise.resolve();
}
async function twoPaints() {
  await paint();
  await paint();
}
const masked = () => document.documentElement.hasAttribute('data-privacy');

it('界面备份 hydrate 不解除在途覆盖，释放后采用恢复得到的永久偏好', () => {
  usePrivacyStore.getState().set(true);
  const release = usePrivacyStore.getState().beginTemporary();
  try {
    applyWeqClientSettings(localStorage, {
      [PRIVACY_STORAGE_KEY]: '0',
      [CAPTURE_PRIVACY_STORAGE_KEY]: '1',
    });
    usePrivacyStore.getState().hydrate();
    expect(usePrivacyStore.getState().enabled).toBe(false);
    expect(usePrivacyStore.getState().capturePrivacy).toBe(true);
    expect(masked()).toBe(true);
  } finally {
    release();
  }
  expect(masked()).toBe(false);
});

it('默认关闭，启用偏好持久化且纳入设备备份，临时状态不写入存储', async () => {
  expect(usePrivacyStore.getState().capturePrivacy).toBe(false);
  usePrivacyStore.getState().setCapturePrivacy(true);
  expect(localStorage.getItem(CAPTURE_PRIVACY_STORAGE_KEY)).toBe('1');
  const close = vi.fn(),
    capture = vi.fn(async () => ({ ok: true }));
  const run = captureMenuScreenshot(capture, close);
  expect(close).toHaveBeenCalledOnce();
  expect(masked()).toBe(true);
  expect(usePrivacyStore.getState().enabled).toBe(false);
  expect(localStorage.getItem(PRIVACY_STORAGE_KEY)).toBeNull();
  expect(capture).not.toHaveBeenCalled();
  await paint();
  expect(capture).not.toHaveBeenCalled();
  await paint();
  await run;
  expect(capture).toHaveBeenCalledOnce();
  expect(masked()).toBe(false);
  expect(snapshotWeqClientSettings(localStorage)).toEqual({ [CAPTURE_PRIVACY_STORAGE_KEY]: '1' });
  expect(() => validateWeqClientSettings({ [CAPTURE_PRIVACY_STORAGE_KEY]: 'true' })).toThrow();
});
it.each([false, true])('截图期间修改永久偏好为 %s，结束后保留最新值', async (latest) => {
  usePrivacyStore.getState().setCapturePrivacy(true);
  let finish!: () => void;
  const run = captureMenuScreenshot(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    () => {},
  );
  await twoPaints();
  usePrivacyStore.getState().set(!latest);
  usePrivacyStore.getState().set(latest);
  expect(masked()).toBe(true);
  finish();
  await run;
  expect(masked()).toBe(latest);
  expect(usePrivacyStore.getState().enabled).toBe(latest);
  expect(localStorage.getItem(PRIVACY_STORAGE_KEY)).toBe(latest ? '1' : '0');
});
it('原隐私已开启时仍保持开启，临时覆盖所有权独立且释放幂等', () => {
  const store = usePrivacyStore.getState();
  store.set(true);
  const releaseA = store.beginTemporary(),
    releaseB = store.beginTemporary();
  store.set(false);
  releaseA();
  releaseA();
  expect(masked()).toBe(true);
  releaseB();
  expect(masked()).toBe(false);
  store.set(true);
  const release = store.beginTemporary();
  release();
  expect(masked()).toBe(true);
});
it('并发截图完成一项不提前解除另一项的遮罩', async () => {
  usePrivacyStore.getState().setCapturePrivacy(true);
  let finishA!: () => void, finishB!: () => void;
  const a = captureMenuScreenshot(
    () =>
      new Promise<void>((resolve) => {
        finishA = resolve;
      }),
    () => {},
  );
  const b = captureMenuScreenshot(
    () =>
      new Promise<void>((resolve) => {
        finishB = resolve;
      }),
    () => {},
  );
  await twoPaints();
  finishA();
  await a;
  expect(masked()).toBe(true);
  finishB();
  await b;
  expect(masked()).toBe(false);
});
it.each(['cancel', 'throw'])('截图 %s 时在 finally 中撤销临时覆盖', async (kind) => {
  usePrivacyStore.getState().setCapturePrivacy(true);
  const run = captureMenuScreenshot(
    async () => {
      if (kind === 'throw') throw new Error('合成截图失败');
      return { ok: false };
    },
    () => {},
  );
  const result =
    kind === 'throw'
      ? expect(run).rejects.toThrow('截图失败')
      : expect(run).resolves.toEqual({ ok: false });
  await twoPaints();
  await result;
  expect(masked()).toBe(false);
});
it('绘制等待时窗口离开，取消截图并释放帧/遮罩；没有调用原生捕获', async () => {
  usePrivacyStore.getState().setCapturePrivacy(true);
  const capture = vi.fn();
  const run = captureMenuScreenshot(capture, () => {});
  const result = expect(run).rejects.toThrow('已取消截图');
  window.dispatchEvent(new Event('pagehide'));
  await result;
  expect(capture).not.toHaveBeenCalled();
  expect(masked()).toBe(false);
  expect(frames.size).toBe(0);
});
it('后台帧停滞有界失败', async () => {
  usePrivacyStore.getState().setCapturePrivacy(true);
  const capture = vi.fn();
  const run = captureMenuScreenshot(capture, () => {});
  expect(masked()).toBe(true);
  const result = expect(run).rejects.toThrow('绘制未完成');
  await vi.advanceTimersByTimeAsync(3000);
  await result;
  expect(capture).not.toHaveBeenCalled();
  expect(masked()).toBe(false);
  expect(frames.size).toBe(0);
});
it('默认关闭时保留现有直点/悬停截图行为，不关闭菜单或额外等待', async () => {
  const close = vi.fn(),
    capture = vi.fn(async () => ({ ok: true }));
  expect(await captureMenuScreenshot(capture, close)).toEqual({ ok: true });
  expect(close).not.toHaveBeenCalled();
  expect(capture).toHaveBeenCalledOnce();
  expect(masked()).toBe(false);
  expect(frames.size).toBe(0);
});
