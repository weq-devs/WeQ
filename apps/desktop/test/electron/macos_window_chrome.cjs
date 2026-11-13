const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

const temporary = process.env.WEQ_CHROME_TEMP;
app.setPath('userData', resolve(temporary, 'profile'));
app.whenReady().then(async () => {
  let win;
  try {
    const chrome = await import(resolve(temporary, 'main.mjs'));
    let controls = 'native';
    chrome.registerWindowChromeIpc(() => controls);
    ipcMain.handle('window:get-controls', () => controls);
    win = new BrowserWindow({
      show: false,
      width: 600,
      height: 900,
      titleBarStyle: 'hidden',
      webPreferences: {
        preload: resolve(temporary, 'preload.cjs'),
        sandbox: false,
        contextIsolation: true,
      },
    });
    win.setWindowButtonVisibility(true);
    chrome.installWindowChrome(win, () => controls);
    const origin = process.env.WEQ_CHROME_ORIGIN;
    win.webContents.session.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(origin) && !details.url.startsWith('data:') }),
    );
    await win.loadURL(`${origin}/test/browser/desktop-portrait.html`);
    const wait = async (condition) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await win.webContents.executeJavaScript(condition)) return;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      throw new Error(`Timed out: ${condition}`);
    };
    await wait("document.querySelector('.chat-header')?.getBoundingClientRect().top===0");
    const initial = await win.webContents.executeJavaScript(
      "({snapshot:window.weq.windowChrome.getSnapshot(),left:getComputedStyle(document.querySelector('.chat-header')).paddingLeft})",
    );
    assert.equal(initial.snapshot.inline, true);
    assert.equal(initial.snapshot.layout.width, win.getContentSize()[0]);
    assert.equal(initial.left, '84px');
    assert.equal(
      await win.webContents.executeJavaScript(
        "getComputedStyle(document.querySelector('.chat-header')).getPropertyValue('-webkit-app-region')",
      ),
      'drag',
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        "getComputedStyle(document.querySelector('.chat-header button')).getPropertyValue('-webkit-app-region')",
      ),
      'no-drag',
    );
    win.setContentSize(430, 900);
    await wait('window.weq.windowChrome.getSnapshot().layout.width===430');
    controls = 'windows';
    win.setWindowButtonVisibility(false);
    win.webContents.send('window:controls-changed', controls);
    chrome.publishWindowChrome(win, controls);
    await wait("document.querySelector('.chat-header')?.getBoundingClientRect().top===40");
    assert.equal(
      await win.webContents.executeJavaScript(
        "document.querySelectorAll('.app-title-bar-actions button').length",
      ),
      3,
    );
    controls = 'native';
    win.setWindowButtonVisibility(true);
    win.webContents.send('window:controls-changed', controls);
    chrome.publishWindowChrome(win, controls);
    await wait("document.querySelector('.chat-header')?.getBoundingClientRect().top===0");
    // 验证全屏事件的桥接与清理，不切换用户正在使用的 macOS 桌面空间。
    const originalFullscreen = win.isFullScreen.bind(win);
    win.isFullScreen = () => true;
    win.emit('enter-full-screen');
    await wait('window.weq.windowChrome.getSnapshot().layout.topLeft.width===0');
    win.isFullScreen = originalFullscreen;
    win.emit('leave-full-screen');
    await wait('window.weq.windowChrome.getSnapshot().layout.topLeft.width===76');
    console.log(
      'PASS: Electron 隔离窗口的真实 preload/IPC、初始状态、缩放和按钮偏好；全屏事件合成验证通过',
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    win?.destroy();
    app.exit(process.exitCode ?? 0);
  }
});
