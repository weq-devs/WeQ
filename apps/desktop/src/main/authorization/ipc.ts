import { ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { resolveNtHelperPath } from '@weq/native';
import { getMainWindow } from '../main_window';
import { AuthorizationInstaller } from './install';

export function registerLongTermAuthorizationIpc(): void {
  const installer = new AuthorizationInstaller({
    helper: () =>
      join(
        dirname(resolveNtHelperPath()),
        process.platform === 'win32' ? 'weq-authorization-helper.exe' : 'weq-authorization-helper',
      ),
    platform: process.platform,
  });
  for (const operation of ['status', 'install', 'remove'] as const) {
    ipcMain.handle(`authorization:${operation}`, (event) => {
      const window = getMainWindow();
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('长期授权只能在本机 WeQ 主窗口管理');
      return installer[operation]();
    });
  }
}
