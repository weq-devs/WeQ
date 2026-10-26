import { app, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { resolveNtHelperPath } from '@weq/native';
import { getMainWindow } from '../main_window';
import { AuthorizationInstaller } from './install';
import { authorizationHelperPath } from './helper_path';
import { getAppContext } from '../context/app_context';
import { AuthorizationFullModeMonitor } from './full_mode';

export function registerLongTermAuthorizationIpc(): void {
  const installer = new AuthorizationInstaller({
    helper: () =>
      authorizationHelperPath({
        bundled: () =>
          join(
            dirname(resolveNtHelperPath()),
            process.platform === 'win32'
              ? 'weq-authorization-helper.exe'
              : 'weq-authorization-helper',
          ),
        packaged: app.isPackaged,
        override: process.env.WEQ_AUTHORIZATION_HELPER_PATH,
        platform: process.platform,
      }),
    platform: process.platform,
    allowDevelopment: !app.isPackaged,
  });
  const fullMode = new AuthorizationFullModeMonitor(getAppContext, () => installer.status());
  fullMode.start();
  app.once('will-quit', () => fullMode.stop());
  for (const operation of ['status', 'install', 'remove'] as const) {
    ipcMain.handle(`authorization:${operation}`, (event, expectedDevelopment?: unknown) => {
      const window = getMainWindow();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('长期授权只能在本机 WeQ 主窗口管理');
      if (expectedDevelopment !== undefined && typeof expectedDevelopment !== 'boolean')
        throw new Error('权限助手通道参数无效');
      return operation === 'status'
        ? fullMode.check()
        : operation === 'install'
          ? fullMode.check(() => installer.install(expectedDevelopment))
          : installer.remove(expectedDevelopment);
    });
  }
}
