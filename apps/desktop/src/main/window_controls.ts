import { type BrowserWindow, View, WebContentsView } from 'electron';
import { is } from '@electron-toolkit/utils';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { windowDecorationOptions } from './window_controls_events';
export { windowDecorationOptions } from './window_controls_events';

const HEADER_HEIGHT = 32;

/** 独立网页和工具窗的可信标题栏，不把应用 preload 注入远程页面或报告。 */
export function installWindowControls(
  win: BrowserWindow,
  custom = windowDecorationOptions().frame === false,
): void {
  if (!custom) return;
  const header = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  const content = win.contentView;
  const container = new View();
  win.setContentView(container);
  container.addChildView(content);
  container.addChildView(header);
  const resize = () => {
    if (win.isDestroyed()) return;
    const [width = 0, height = 0] = win.getContentSize();
    content.setBounds({
      x: 0,
      y: HEADER_HEIGHT,
      width,
      height: Math.max(0, height - HEADER_HEIGHT),
    });
    header.setBounds({ x: 0, y: 0, width, height: HEADER_HEIGHT });
  };
  resize();
  win.on('resize', resize);
  win.once('closed', () => {
    header.webContents.close();
  });
  header.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  header.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (url === 'weq-window-control:close') win.close();
    else if (url === 'weq-window-control:minimize') win.minimize();
    else if (url === 'weq-window-control:maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });
  const query = { title: win.getTitle() };
  const load =
    is.dev && process.env.ELECTRON_RENDERER_URL
      ? header.webContents.loadURL(
          `${process.env.ELECTRON_RENDERER_URL}/window-controls.html?${new URLSearchParams(query)}`,
        )
      : header.webContents.loadFile(
          join(dirname(fileURLToPath(import.meta.url)), '../renderer/window-controls.html'),
          { query },
        );
  void load.catch((error: unknown) => console.error('窗口按钮加载失败', error));
}
