const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');

app.setPath('userData', resolve(process.env.WEQ_STARTUP_TEMP, 'profile'));
app.whenReady().then(async () => {
  const windows = [];
  try {
    const helpers = await import(resolve(process.env.WEQ_STARTUP_TEMP, 'helpers.mjs'));
    for (const showInitially of [true, false]) {
      const layout = 'chat';
      const win = new BrowserWindow({
        ...helpers.WINDOW_LAYOUTS[layout],
        useContentSize: true,
        show: false,
        titleBarStyle: 'hidden',
      });
      windows.push(win);
      helpers.applyWindowLayout(win, layout, { x: 0, y: 0, width: 1800, height: 1200 });
      helpers.installStartupWindowReveal(win, showInitially);
      const painted = new Promise((resolvePromise) => win.once('ready-to-show', resolvePromise));
      if (process.env.WEQ_STARTUP_HTML) await win.loadFile(process.env.WEQ_STARTUP_HTML);
      else await win.loadURL(`${process.env.WEQ_STARTUP_ORIGIN}/?static=1`);
      await Promise.race([
        painted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('首屏未绘制')), 10000)),
      ]);
      assert.equal(win.isVisible(), showInitially, '隐藏自启不能被首屏加载唤起');
      const bounds = win.getBounds();
      const size = win.getContentSize();
      helpers.applyWindowLayout(win, layout, { x: 0, y: 0, width: 1800, height: 1200 });
      assert.deepEqual(win.getBounds(), bounds, '首次同布局 IPC 不改变外框尺寸或位置');
      assert.deepEqual(size, [
        helpers.WINDOW_LAYOUTS.chat.width,
        helpers.WINDOW_LAYOUTS.chat.height,
      ]);
      assert.equal(
        await win.webContents.executeJavaScript(
          "Boolean(document.querySelector('[role=progressbar]') && (document.querySelector('.weq-warmup-logo')?.naturalWidth > 0 || getComputedStyle(document.querySelector('.weq-warmup-logo')).backgroundImage !== 'none'))",
        ),
        true,
      );
      const capture = await win.webContents.capturePage();
      assert.equal(capture.isEmpty(), false);
      const pixels = capture.toBitmap();
      const colors = new Set();
      for (let offset = 0; offset < pixels.length; offset += 64)
        colors.add(pixels.readUInt32LE(offset));
      assert(colors.size > 10, '首次窗口捕获不能是纯色空白');
    }
    console.log(
      'PASS: Electron 隔离窗口首次绘制内容/像素、创建与首次布局尺寸一致、隐藏自启不显示。',
    );
    writeFileSync(
      resolve(process.env.WEQ_STARTUP_TEMP, 'receipt.json'),
      JSON.stringify({ cases: 2, pixels: true, stableBounds: true, hiddenAutostart: true }),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    app.exit(process.exitCode ?? 0);
  }
});
