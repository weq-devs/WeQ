// @vitest-environment node
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEVELOPMENT_RESTART_EXIT_CODE,
  scheduleDevelopmentRestart,
} from '../src/main/development_restart';

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const app = Object.assign(new EventEmitter(), { exit: vi.fn() });
  const request = new AbortController();
  const willQuit = (defaultPrevented = false) => {
    const event = { defaultPrevented, preventDefault: vi.fn() };
    app.emit('will-quit', event);
    return event;
  };
  return { app, request, willQuit };
}

it('等待窗口和退出清理放行，随后只向启动器提交一次重启', async () => {
  vi.stubEnv('WEQ_DEV_RESTART_MANAGED', '1');
  const { app, request, willQuit } = fixture();
  scheduleDevelopmentRestart(app, request.signal);

  const blocked = willQuit(true);
  await setImmediate();
  expect(blocked.preventDefault).not.toHaveBeenCalled();
  expect(app.exit).not.toHaveBeenCalled();

  const ready = willQuit();
  expect(ready.preventDefault).toHaveBeenCalledOnce();
  willQuit();
  await setImmediate();
  expect(app.exit.mock.calls).toEqual([[DEVELOPMENT_RESTART_EXIT_CODE]]);
  expect(app.listenerCount('will-quit')).toBe(0);
});

it('取消重启后，之后的正常退出不提交重启', async () => {
  vi.stubEnv('WEQ_DEV_RESTART_MANAGED', '1');
  const { app, request, willQuit } = fixture();
  scheduleDevelopmentRestart(app, request.signal);
  request.abort();

  expect(willQuit().preventDefault).not.toHaveBeenCalled();
  await setImmediate();
  expect(app.exit).not.toHaveBeenCalled();
});

it('启动器未接管重启时保留当前应用', () => {
  vi.stubEnv('WEQ_DEV_RESTART_MANAGED', undefined);
  const { app, request } = fixture();
  expect(() => scheduleDevelopmentRestart(app, request.signal)).toThrow('pnpm dev');
  expect(app.listenerCount('will-quit')).toBe(0);
  expect(app.exit).not.toHaveBeenCalled();
});
