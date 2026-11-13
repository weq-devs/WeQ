const assert = require('node:assert/strict');
const { app, BrowserWindow, View, WebContentsView } = require('electron');

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, frame: false, width: 640, height: 480 });
    const content = win.contentView;
    if (process.env.WEQ_WINDOW_CONTROLS_MODULE) {
      const controls = await import(process.env.WEQ_WINDOW_CONTROLS_MODULE);
      controls.registerWindowControlsPreference(() => true);
      controls.installWindowControls(win);
      const header = win.contentView.children[1];
      await new Promise((resolve) => header.webContents.once('did-finish-load', resolve));
      await win.loadURL('data:text/html,<body>content</body>');
      assert.equal(content.getBounds().y, 32);
      win.setContentSize(800, 600);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(content.getBounds(), { x: 0, y: 32, width: 800, height: 568 });
      assert.deepEqual(header.getBounds(), { x: 0, y: 0, width: 800, height: 32 });
      let minimized = 0;
      let maximized = false;
      let closed = 0;
      win.minimize = () => {
        minimized++;
      };
      win.isMaximized = () => maximized;
      win.maximize = () => {
        maximized = true;
      };
      win.unmaximize = () => {
        maximized = false;
      };
      win.on('close', (event) => {
        event.preventDefault();
        closed++;
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        if (
          await header.webContents.executeJavaScript(
            'document.querySelectorAll("button").length === 3',
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const [label, verify] of [
        ['最小化', () => assert.equal(minimized, 1)],
        ['最大化/还原', () => assert.equal(maximized, true)],
        ['最大化/还原', () => assert.equal(maximized, false)],
        ['关闭', () => assert.equal(closed, 1)],
      ]) {
        await header.webContents.executeJavaScript(
          `document.querySelector('[aria-label="${label}"]').click()`,
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
        verify();
      }
      assert.equal(win.webContents.getURL().startsWith('data:text/html'), true);
      win.destroy();
      console.log('PASS: 真实自绘标题栏加载、最小化、最大化/还原与关闭，不影响内容页');
      return;
    }
    const container = new View();
    const header = new WebContentsView({ webPreferences: { sandbox: true } });
    win.setContentView(container);
    container.addChildView(content);
    container.addChildView(header);
    content.setBounds({ x: 0, y: 32, width: 640, height: 448 });
    header.setBounds({ x: 0, y: 0, width: 640, height: 32 });
    await win.loadURL('data:text/html,<body>content</body>');
    assert.equal(content.getBounds().y, 32);
    assert.equal(content.getBounds().height, 448);
    assert.equal(win.webContents.isDestroyed(), false);
    assert.equal(container.children.length, 2);
    console.log('PASS: BrowserWindow 独立标题栏保留原 WebContents，正文下移且不被遮挡');
    win.destroy();
    header.webContents.close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode ?? 0);
  }
});
