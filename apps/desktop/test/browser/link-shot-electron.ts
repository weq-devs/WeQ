import { app, BrowserWindow, nativeImage } from 'electron';
import { screenshotPage } from '../../src/main/link_shot';

if (process.env.WEQ_LINK_SHOT_USER_DATA)
  app.setPath('userData', process.env.WEQ_LINK_SHOT_USER_DATA);
app.setName('WeQ Link Screenshot QA');
app.on('window-all-closed', () => {});
void app.whenReady().then(() => {
  Object.assign(globalThis, {
    async linkShotQA(cancel = false) {
      const controller = new AbortController();
      const requests: string[] = [];
      const html = `<html><head><style>body{margin:0;background:#ed3344}#paint{height:640px}</style></head><body><div id="paint">fixture</div><script src="/paint.js"></script><img src="http://127.0.0.1/private"><iframe src="http://127.0.0.1/frame"></iframe><script>fetch('file:///etc/passwd').catch(()=>{});new WebSocket('ws://127.0.0.1/socket');</script></body></html>`;
      const timer = cancel ? setTimeout(() => controller.abort(), 20) : undefined;
      const png = await screenshotPage({
        url: 'http://synthetic.invalid/page',
        html,
        signal: controller.signal,
        fetchResource: async (url) => {
          requests.push(url);
          if (url !== 'http://synthetic.invalid/paint.js') return null;
          return {
            url,
            contentType: 'text/javascript',
            bytes: Buffer.from("document.getElementById('paint').style.background='#228844';"),
          };
        },
      });
      clearTimeout(timer);
      const image = png ? nativeImage.createFromBuffer(png) : null;
      const bitmap = image?.toBitmap();
      let painted = false;
      for (let index = 0; bitmap && index < bitmap.length; index += 4)
        if (bitmap[index] === 0x44 && bitmap[index + 1] === 0x88 && bitmap[index + 2] === 0x22) {
          painted = true;
          break;
        }
      return {
        requests,
        painted,
        png: Boolean(png),
        windows: BrowserWindow.getAllWindows().length,
      };
    },
  });
});
