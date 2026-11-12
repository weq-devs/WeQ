import { ipcRenderer } from 'electron';
import type { NativeWindowChrome, WindowChromeBridge } from '../shared/window_chrome';

// 仅 macOS 启动时读取一次本窗口的轻量状态，保证首次绘制就知道按钮样式和占位。
// 后续只收事件；缩放、全屏与偏好变化不做同步 IPC 或轮询。
let snapshot: NativeWindowChrome | null =
  process.platform === 'darwin' ? ipcRenderer.sendSync('window:get-chrome') : null;
ipcRenderer.on('window:chrome-changed', (_event, value: NativeWindowChrome) => {
  snapshot = value;
});

export const windowChromeBridge: WindowChromeBridge = {
  getSnapshot: () => snapshot,
  onChange(handler) {
    const listener = (_event: Electron.IpcRendererEvent, value: NativeWindowChrome) =>
      handler(value);
    ipcRenderer.on('window:chrome-changed', listener);
    return () => ipcRenderer.removeListener('window:chrome-changed', listener);
  },
};
