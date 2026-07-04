/**
 * 打开导出 bot 的 WebUI 控制台窗口（本机 http 页面）。
 *
 * 用导出时生成的密钥「免手输」直接登录：先 loadURL 打开控制台，页面首帧加载完成后注入
 * sessionStorage 密钥并 reload —— 控制台前端在 sessionStorage 有密钥时会自动进主界面。
 *
 * 窗口隔离：无 preload（加载的是 bot 自己的页面，不该看到应用的 tRPC bridge），
 * 链接一律走系统浏览器。镜像 report_window.ts 的隔离范式。
 */
import { BrowserWindow } from 'electron';

/** 探活：GET <url> 判断 bot 的 WebUI 是否在跑（3s 超时）。 */
export async function probeBotWebUi(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return res.ok || res.status === 401; // 200 页面 或 401（服务在跑，只是缺鉴权）都算可达
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 打开控制台窗口并用密钥自动登录。url 为基址（如 http://127.0.0.1:8090）。 */
export async function openBotWebUiWindow(url: string, key: string, botName?: string): Promise<void> {
  const win = new BrowserWindow({
    width: 1040,
    height: 800,
    minWidth: 520,
    minHeight: 420,
    title: botName ? `${botName} · 控制台` : '克隆体 · 控制台',
    autoHideMenuBar: true,
    backgroundColor: '#0f1216',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      // 无 preload：控制台是 bot 自己的页面，应用的特权 bridge 不能进它的视野。
    },
  });
  // 控制台里的外链一律走系统浏览器，不在本窗口内导航/开子窗。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 首帧加载完成后注入密钥并 reload（once：只在首次注入，reload 后的加载不再重复）。
  win.webContents.once('did-finish-load', () => {
    const js = `try { sessionStorage.setItem('weq-bot-key', ${JSON.stringify(key)}); location.reload(); } catch (e) {}`;
    void win.webContents.executeJavaScript(js).catch(() => undefined);
  });

  await win.loadURL(url);
}
