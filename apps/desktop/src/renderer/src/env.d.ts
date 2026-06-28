/// <reference types="vite/client" />

interface Window {
  weq: {
    openLogDir(): Promise<boolean>;
    channel: {
      open(): Promise<boolean>;
      getCookies(): Promise<
        { name: string; value: string; domain?: string; path?: string }[]
      >;
    };
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
