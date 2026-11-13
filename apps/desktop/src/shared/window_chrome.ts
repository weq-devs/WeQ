import type { WindowControlsStyle } from './window_controls';

export type WindowCornerLayout = {
  width: number;
  height: number;
  topLeft: { width: number; height: number };
  topRight: { width: number; height: number };
};
export type NativeWindowChrome = {
  controls: WindowControlsStyle;
  inline: boolean;
  layout: WindowCornerLayout;
};
export type WindowChromeBridge = {
  getSnapshot(): NativeWindowChrome | null;
  onChange(handler: (value: NativeWindowChrome) => void): () => void;
};

// 延续主窗口原有的 84px 横向预留（含共用避让器的 8px 间距）与 40px 窗口栏范围。
// Electron 不提供默认红绿灯的完整包围盒；这里是应用布局约定，不冒充实时测量。
export const MACOS_WINDOW_CORNER = { width: 76, height: 40 } as const;

export function nativeWindowChrome({
  platform,
  controls,
  fullscreen,
  width,
  height,
}: {
  platform: string;
  controls: WindowControlsStyle;
  fullscreen: boolean;
  width: number;
  height: number;
}): NativeWindowChrome {
  const inline = platform === 'darwin' && controls === 'native';
  return {
    controls,
    inline,
    layout: {
      width,
      height,
      topLeft: inline && !fullscreen ? { ...MACOS_WINDOW_CORNER } : { width: 0, height: 0 },
      topRight: { width: 0, height: 0 },
    },
  };
}
