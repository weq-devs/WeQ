import { app, BrowserWindow } from 'electron';
app.setPath('userData', process.env.WEQ_SYNC_ELECTRON_PROFILE!);
async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  await window.loadURL(process.env.WEQ_SYNC_SCENE_URL!);
}
void main().catch((error) => {
  console.error(error);
  app.exit(1);
});
