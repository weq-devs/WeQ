/// <reference types="vite/client" />

interface Window {
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
