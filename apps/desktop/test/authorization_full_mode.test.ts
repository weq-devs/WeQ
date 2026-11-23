// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { registerLongTermAuthorizationIpc } from '../src/main/authorization/ipc';
import { fullModeAllowed } from '../src/main/context/full_mode';

type AuthorizationHandler = (event: object, expectedDevelopment?: unknown) => unknown;

const f = vi.hoisted(() => {
  const mainFrame = {};
  const webContents = { mainFrame };
  const handlers = new Map<string, AuthorizationHandler>();
  const settings = { autoAttachQq: true };
  const host = {
    account: {},
    accountIsStatic: false,
    bootstrap: {
      userConfig: {
        getSettings: () => settings,
        setSettings: (patch: Partial<typeof settings>) => Object.assign(settings, patch),
      },
    },
    refreshRkeysNow: vi.fn(async () => true),
  };
  return {
    handlers,
    host,
    settings,
    webContents,
    mainFrame,
    status: vi.fn(),
    install: vi.fn(),
  };
});
vi.mock('electron', () => ({
  app: { isPackaged: false, once: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: AuthorizationHandler) => f.handlers.set(name, handler),
  },
}));
vi.mock('../src/main/main_window', () => ({
  getMainWindow: () => ({ webContents: f.webContents }),
}));
vi.mock('../src/main/context/app_context', () => ({ getAppContext: () => f.host }));
vi.mock('../src/main/authorization/install', () => ({
  AuthorizationInstaller: class {
    status = f.status;
    install = f.install;
  },
}));

beforeEach(() => {
  f.handlers.clear();
  f.settings.autoAttachQq = true;
  f.host.refreshRkeysNow.mockClear();
});

it.each(['status', 'install'] as const)(
  '关闭 QQ 在线能力后忽略长期授权 %s 的迟到就绪结果',
  async (operation) => {
    const ready = { state: 'ready' };
    let finish!: () => void;
    f[operation].mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ready);
        }),
    );
    registerLongTermAuthorizationIpc();
    const result = f.handlers.get(`authorization:${operation}`)!({
      sender: f.webContents,
      senderFrame: f.mainFrame,
    });
    f.settings.autoAttachQq = false;
    finish();
    expect(await result).toEqual(ready);
    expect(fullModeAllowed(f.host)).toBe(false);
    expect(f.host.refreshRkeysNow).not.toHaveBeenCalled();
  },
);
