import { ipcRenderer } from 'electron';
import type { RendererRecoveryBridge } from '../shared/renderer_recovery';

export const rendererRecoveryBridge = {
  getNotice: () => ipcRenderer.invoke('renderer-recovery:notice'),
  acknowledgeNotice: (id: number) => ipcRenderer.invoke('renderer-recovery:acknowledge', id),
} satisfies RendererRecoveryBridge;
