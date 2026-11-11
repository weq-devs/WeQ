import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { captureMenuScreenshot } from '../src/renderer/src/lib/menuScreenshot';
import type { PreferencePatch } from '@weq/service/client-preferences';

/*
 * bc972cf1 起，界面偏好以「共享值」（电脑端服务里的 client-state）为权威：
 * - `preferenceValue()` 优先取 pending（本机刚改、还没保存成功的值），其次取共享值，
 *   最后才用 localStorage 里的本机键兜底。
 * - localStorage 的本机键只用于迁移/兜底（旧安装、断网首帧），不再能覆盖已有的共享值。
 * - 备份恢复会把界面偏好通过 restoreBackupClient → applyShared 写成共享值，而不是只写本机键。
 * 因此下面同时覆盖三条路径：① 备份恢复写共享值并生效；② 只写本机键时共享值不被覆盖；
 * ③ 保存失败时 pending 保留本机值并可重试。
 */

const server = vi.hoisted(() => ({
  revision: 0,
  values: {} as Record<string, unknown>,
  failNext: null as Error | null,
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    clientState: {
      patch: {
        mutate: async (patch: Record<string, unknown>) => {
          if (server.failNext) {
            const error = server.failNext;
            server.failNext = null;
            throw error;
          }
          server.values = { ...server.values, ...patch };
          server.revision += 1;
          return { revision: server.revision, values: { ...server.values }, records: {} };
        },
      },
      snapshot: {
        query: async () => ({
          revision: server.revision,
          values: { ...server.values },
          records: {},
        }),
      },
    },
  },
  trpc: { useUtils: () => ({}) },
}));

import {
  usePrivacyStore,
  PRIVACY_STORAGE_KEY,
  CAPTURE_PRIVACY_STORAGE_KEY,
} from '../src/renderer/src/state/privacy';
import {
  acceptPreferences,
  preferenceValue,
  retryPreferences,
} from '../src/renderer/src/lib/clientPreferences';
import {
  applyWeqClientSettings,
  snapshotWeqClientSettings,
  validateWeqClientSettings,
} from '@weq/service/backup-client';
import { restoreBackupClient } from '../src/renderer/src/lib/backupClientRestore';

/** restoreBackupClient 读取的「待应用共享值」意图键（见 backupClientRestore.ts:49）。 */
const RESTORE_INTENT_KEY = 'weq.sync.restored-shared';

let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;
let epoch = 0;
beforeEach(async () => {
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
  // 每个用例从空的共享快照开始，避免上一个用例的 pending / 共享值串味。
  server.values = {};
  server.revision = 0;
  server.failNext = null;
  // 先让上一个用例可能残留的 pending 落盘（隐私 store 的 set 是 fire-and-forget），
  // 再用空快照清空共享值；否则 pending 会优先于空共享值被 hydrate 读到。
  retryPreferences();
  await settle();
  acceptPreferences({ epoch: `test-${++epoch}`, revision: 0, values: {}, records: {} }, false);
  usePrivacyStore.getState().hydrate();
});
afterEach(async () => {
  // 隐私 store 的 set() 是 fire-and-forget：用例结束前把在途保存冲掉，
  // 否则下一次 hydrate 会读到上一个用例的 pending 值。
  retryPreferences();
  await settle();
  vi.restoreAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  acceptPreferences({ epoch: `after-${++epoch}`, revision: 0, values: {}, records: {} }, false);
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
async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  for (let index = 0; index < 20; index++) await Promise.resolve();
}
const masked = () => document.documentElement.hasAttribute('data-privacy');

/** 用假的备份恢复 API 走完整 restoreBackupClient 链路，界面偏好会被写成共享值。 */
async function restoreFromBackup(values: Record<string, string>) {
  const receipt = '11111111-1111-4111-8111-111111111111';
  localStorage.setItem(RESTORE_INTENT_KEY, JSON.stringify(values));
  return restoreBackupClient(
    {
      read: async () => ({
        ok: true,
        error: null,
        result: { id: receipt, clientPending: true },
        appliedThisStartup: false,
        client: { id: receipt, values },
        canReveal: false,
        canRestart: false,
      }),
      acknowledge: async () => true,
      applyShared: async (_id: string, patch: PreferencePatch) => {
        server.values = { ...server.values, ...patch };
        server.revision += 1;
        return true;
      },
    },
    localStorage,
  );
}

it('备份恢复经 applyShared 写共享值，不解除在途覆盖，释放后采用恢复得到的偏好', async () => {
  usePrivacyStore.getState().set(true);
  await settle();
  expect(server.values.privacyMode).toBe(true);
  const release = usePrivacyStore.getState().beginTemporary();
  try {
    await restoreFromBackup({
      [PRIVACY_STORAGE_KEY]: '0',
      [CAPTURE_PRIVACY_STORAGE_KEY]: '1',
    });
    acceptPreferences(
      { revision: server.revision, values: { ...server.values }, records: {} },
      false,
    );
    usePrivacyStore.getState().hydrate();
    // 共享值已被恢复写成 false，本机键只是同值副本。
    expect(server.values.privacyMode).toBe(false);
    expect(usePrivacyStore.getState().enabled).toBe(false);
    expect(usePrivacyStore.getState().capturePrivacy).toBe(true);
    // 在途的临时覆盖仍然生效，不能被 hydrate 解除。
    expect(masked()).toBe(true);
  } finally {
    release();
  }
  expect(masked()).toBe(false);
});

it('只写本机键、共享值已存在时不覆盖共享值（旧的 localStorage 权威模型不再成立）', async () => {
  usePrivacyStore.getState().set(true);
  await settle();
  expect(server.values.privacyMode).toBe(true);
  applyWeqClientSettings(localStorage, {
    [PRIVACY_STORAGE_KEY]: '0',
    [CAPTURE_PRIVACY_STORAGE_KEY]: '1',
  });
  usePrivacyStore.getState().hydrate();
  // 本机键写的是 0，但共享值仍是 true，所以隐私模式保持开启。
  expect(localStorage.getItem(PRIVACY_STORAGE_KEY)).toBe('0');
  expect(usePrivacyStore.getState().enabled).toBe(true);
  expect(masked()).toBe(true);
  // 只有在共享值缺失时，本机键才作为迁移/兜底生效。
  acceptPreferences({ epoch: `empty-${++epoch}`, revision: 0, values: {}, records: {} }, false);
  usePrivacyStore.getState().hydrate();
  expect(usePrivacyStore.getState().enabled).toBe(false);
  expect(usePrivacyStore.getState().capturePrivacy).toBe(true);
});

it('保存失败时 pending 保留本机值，重试后写成共享值', async () => {
  const mod = await import('../src/renderer/src/trpc/client');
  const attempts: unknown[] = [];
  const original = mod.client.clientState.patch.mutate;
  (mod.client.clientState.patch as { mutate: unknown }).mutate = (patch: unknown) => {
    attempts.push(patch);
    return original(patch as never);
  };
  server.failNext = new Error('合成保存失败');
  usePrivacyStore.getState().set(true);
  expect(usePrivacyStore.getState().enabled).toBe(true);
  expect(masked()).toBe(true);
  // 服务端还没接受：共享值仍是空，但本机值不被 hydrate 冲掉。
  expect(server.values.privacyMode).toBeUndefined();
  usePrivacyStore.getState().hydrate();
  expect(usePrivacyStore.getState().enabled).toBe(true);
  // 失败期间本机值一直保留（pending 优先于共享值）。
  expect(preferenceValue('privacyMode')).toBe(true);
  retryPreferences();
  await settle();
  // 重试会再次提交同一个值（第三次调用是重试），且本机值不变。
  expect(attempts.at(-1)).toEqual({ privacyMode: true });
  expect(preferenceValue('privacyMode')).toBe(true);
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
