if (process.type === 'renderer') {
  const { contextBridge, ipcRenderer } = require('electron');
  contextBridge.exposeInMainWorld('focusTool', (name) =>
    ipcRenderer.send('tool-window:focus', name),
  );
} else {
  const assert = require('node:assert/strict');
  const { app, BrowserWindow, ipcMain } = require('electron');
  const { applicationToolPopupOptions, createToolWindowRegistry } = require(
    process.env.WEQ_TOOL_WINDOW_MODULE,
  );

  const until = async (check, label) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(label);
  };

  app.whenReady().then(async () => {
    const registry = createToolWindowRegistry();
    const children = new Map();
    let owner;
    try {
      owner = new BrowserWindow({
        width: 400,
        height: 300,
        webPreferences: { preload: __filename, contextIsolation: true, sandbox: true },
      });
      ipcMain.on('tool-window:focus', (event, name) => registry.focus(event.sender.id, name));
      owner.webContents.setWindowOpenHandler(({ url, frameName }) => {
        const options = applicationToolPopupOptions(url, frameName);
        return options
          ? { action: 'allow', overrideBrowserWindowOptions: options }
          : { action: 'deny' };
      });
      owner.webContents.on('did-create-window', (child, details) => {
        registry.register(owner.webContents.id, details.frameName, child);
        children.set(details.frameName, child);
      });
      await owner.loadURL('data:text/html,<body>Tool window focus test</body>');
      for (const name of ['weq-compose', 'weq-db-repair']) {
        await owner.webContents.executeJavaScript(`
          window[${JSON.stringify(name)}] = window.open('about:blank', ${JSON.stringify(name)});
          window[${JSON.stringify(name)}].document.body.textContent = 'preserved';
        `);
        await until(() => children.has(name), `missing child: ${name}`);
        const child = children.get(name);
        child.minimize();
        await until(() => child.isMinimized(), `not minimized: ${name}`);
        owner.show();
        owner.focus();
        await until(() => owner.isFocused(), 'owner did not take focus');
        await owner.webContents.executeJavaScript(`focusTool(${JSON.stringify(name)})`);
        await until(
          () => !child.isMinimized() && child.isVisible() && child.isFocused(),
          `not restored and focused: ${name}`,
        );
        child.hide();
        owner.focus();
        await until(() => owner.isFocused(), 'owner did not retake focus');
        await owner.webContents.executeJavaScript(`focusTool(${JSON.stringify(name)})`);
        await until(() => child.isVisible() && child.isFocused(), `not shown and focused: ${name}`);
        assert.equal(
          await owner.webContents.executeJavaScript(
            `window[${JSON.stringify(name)}].document.body.textContent`,
          ),
          'preserved',
        );
        console.log(`PASS: ${name}: restored, revealed, focused; document preserved`);
      }
      assert.equal(children.size, 2);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      for (const child of children.values()) if (!child.isDestroyed()) child.destroy();
      if (owner && !owner.isDestroyed()) owner.destroy();
      app.exit(process.exitCode ?? 0);
    }
  });
}
