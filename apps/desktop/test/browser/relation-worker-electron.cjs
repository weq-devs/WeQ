const { app, BrowserWindow } = require('electron');

app.setPath('userData', process.env.WEQ_RELATION_USER_DATA);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    show: false,
    width: 1180,
    height: 760,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.loadURL('about:blank');
});
app.on('window-all-closed', () => app.quit());
