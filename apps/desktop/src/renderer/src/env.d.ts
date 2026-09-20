/// <reference types="vite/client" />

interface Window {
  electron?: import('@electron-toolkit/preload').ElectronAPI;
  weq: {
    openLogDir(): Promise<boolean>;
    revealPath(path: string): Promise<boolean>;
    channel: {
      open(theme?: 'system' | 'light' | 'dark'): Promise<boolean>;
      prepare(theme?: 'system' | 'light' | 'dark'): Promise<{ partition: string; url: string }>;
      setTheme(theme: 'system' | 'light' | 'dark'): Promise<boolean>;
      getCookies(): Promise<{ name: string; value: string; domain?: string; path?: string }[]>;
    };
    qzone: {
      open(theme?: 'system' | 'light' | 'dark'): Promise<boolean>;
      prepare(theme?: 'system' | 'light' | 'dark'): Promise<{ partition: string; url: string }>;
      setTheme(theme: 'system' | 'light' | 'dark'): Promise<boolean>;
      getCookies(): Promise<{ name: string; value: string; domain?: string; path?: string }[]>;
    };
    flashShare: {
      setTheme(theme: 'system' | 'light' | 'dark'): Promise<boolean>;
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
    totp: {
      getStatus(): Promise<{
        configured: boolean;
        issuer: string;
        label: string;
      }>;
      generateSetup(): Promise<{ secret: string; otpauthUrl: string }>;
      cancelSetup(): Promise<{ ok: boolean }>;
      verify(code: string): Promise<{ ok: boolean; error?: string }>;
      remove(): Promise<{ ok: boolean }>;
    };
    capture: {
      window(): Promise<{ ok: boolean; error?: string }>;
    };
    analyticsShot: {
      /** 主进程在隐藏窗口里渲染同一张卡片、抓成长图、弹保存框（用户窗口全程不动）。 */
      render(
        payload: import('../../shared/analytics_export').AnalyticsExportPayload,
      ): Promise<import('../../shared/analytics_export').AnalyticsExportResult>;
      /** 导出专用入口开窗口时领走待渲染的载荷（只有导出窗口会调）。 */
      claimPayload(): Promise<
        import('../../shared/analytics_export').AnalyticsExportPayload | null
      >;
    };
  };
}
