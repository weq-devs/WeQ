import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { app, BrowserWindow, protocol } from 'electron';
import { applicationToolPopupOptions } from '../../src/main/tool_window';

const source = process.env.WEQ_GROUP_SIDEBAR_URL;
const data = process.env.WEQ_GROUP_SIDEBAR_USER_DATA;
const resources = process.env.WEQ_GROUP_SIDEBAR_RESOURCES;
if (!source || !data || !resources) throw new Error('缺少群聊侧栏 Electron 验收参数');
app.setPath('userData', data);
app.setName('WeQ Group Sidebar QA');
protocol.registerSchemesAsPrivileged([
  { scheme: 'weq-asset', privileges: { standard: true, secure: true, corsEnabled: true } },
]);

void app.whenReady().then(async () => {
  protocol.handle('weq-asset', async (request) => {
    const url = new URL(request.url);
    if (
      url.hostname !== 'fileicon' ||
      !['/pdf.png', '/doc.png', '/folder.png'].includes(url.pathname)
    )
      return new Response(null, { status: 404 });
    return new Response(await readFile(resolve(resources, 'fileicon', url.pathname.slice(1))), {
      headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' },
    });
  });
  const window = new BrowserWindow({
    width: 1180,
    height: 900,
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(({ url, frameName }) => {
    const options = applicationToolPopupOptions(url, frameName);
    return options
      ? { action: 'allow', overrideBrowserWindowOptions: options }
      : { action: 'deny' };
  });
  await window.loadURL(source);
});
app.on('window-all-closed', () => app.quit());
