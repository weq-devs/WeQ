import type { ElectronAPI } from '@electron-toolkit/preload';

declare global {
  interface Window {
    electron: ElectronAPI;
    weq: {
      openLogDir(): Promise<boolean>;
      systemAuth: {
        getStatus(): Promise<{
          platform: string;
          available: boolean;
          method: 'windows-hello' | 'touch-id' | 'none';
          displayName: string;
          error?: string;
        }>;
        verify(reason?: string): Promise<{
          success: boolean;
          method: 'windows-hello' | 'touch-id' | 'none';
          error?: string;
        }>;
      };
    };
  }
}

export {};
