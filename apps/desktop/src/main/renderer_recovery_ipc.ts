import { ipcMain, type WebContents } from 'electron';
import type { createRendererRecovery } from './renderer_recovery';

/** 仅当前主窗口主 frame 可领取/确认通知，内嵌页面与弹窗不能消费它。 */
export function registerRendererRecoveryIpc(
  resolve: (sender: WebContents) => ReturnType<typeof createRendererRecovery> | undefined,
): void {
  const recoveryFor = (event: Electron.IpcMainInvokeEvent) =>
    event.senderFrame === event.sender.mainFrame ? resolve(event.sender) : undefined;
  ipcMain.handle(
    'renderer-recovery:notice',
    (event) => recoveryFor(event)?.rendererReady() ?? null,
  );
  ipcMain.handle('renderer-recovery:acknowledge', (event, id: unknown) => {
    if (typeof id === 'number' && Number.isSafeInteger(id))
      recoveryFor(event)?.acknowledgeNotice(id);
  });
}
