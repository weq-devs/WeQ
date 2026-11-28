import { accountIpc } from '../window_account_runtime';
import { app } from 'electron';
import { dirname, join } from 'node:path';
import { resolveNtHelperPath } from '@weq/native';
import { getMainWindow } from '../main_window';
import { getBootstrapSettingsWindow } from '../bootstrap_settings_window';
import { AuthorizationInstaller } from './install';
import { authorizationHelperPath } from './helper_path';

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
  for (const operation of ['status', 'install', 'remove'] as const) {
    accountIpc.handle(`authorization:${operation}`, (event, expectedDevelopment?: unknown) => {
      const owner = getMainWindow();
      if (
        (event.sender !== owner?.webContents &&
          event.sender !== getBootstrapSettingsWindow(owner)?.webContents) ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('长期授权只能在本机 WeQ 设置中管理');
      if (expectedDevelopment !== undefined && typeof expectedDevelopment !== 'boolean')
        throw new Error('权限助手通道参数无效');
      return operation === 'status'
        ? installer.status()
        : operation === 'install'
          ? installer.install(expectedDevelopment)
          : installer.remove(expectedDevelopment);
    });
  }
}
