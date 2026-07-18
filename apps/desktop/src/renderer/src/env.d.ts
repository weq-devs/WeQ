/// <reference types="vite/client" />

interface Window {
  weq: {
    openLogDir(): Promise<boolean>;
    channel: {
      open(theme?: 'system' | 'light' | 'dark'): Promise<boolean>;
      prepare(theme?: 'system' | 'light' | 'dark'): Promise<{ partition: string; url: string }>;
      setTheme(theme: 'system' | 'light' | 'dark'): Promise<boolean>;
      getCookies(): Promise<
        { name: string; value: string; domain?: string; path?: string }[]
      >;
    };
    qzone: {
      open(theme?: 'system' | 'light' | 'dark'): Promise<boolean>;
      prepare(theme?: 'system' | 'light' | 'dark'): Promise<{ partition: string; url: string }>;
      setTheme(theme: 'system' | 'light' | 'dark'): Promise<boolean>;
      getCookies(): Promise<
        { name: string; value: string; domain?: string; path?: string }[]
      >;
    };
    weqAssistant: {
      setTheme(theme: { accent: string; mode: 'light' | 'dark' }): Promise<boolean>;
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
    capture: {
      window(): Promise<{ ok: boolean; error?: string }>;
    };
  };
}
