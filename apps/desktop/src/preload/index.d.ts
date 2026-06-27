import type { ElectronAPI } from '@electron-toolkit/preload';

declare global {
  interface Window {
    electron: ElectronAPI;
    weq: {
      openLogDir(): Promise<boolean>;
    };
  }
}

export {};
