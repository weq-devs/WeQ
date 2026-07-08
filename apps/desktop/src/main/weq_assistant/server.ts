/**
 * WeQ 助手 local HTTP server (loopback, no auth).
 *
 * QQ itself fetches this server's URLs to render the WeQ 助手 ARK card — the
 * cover image and the click-through page. Because the requester is QQ (not our
 * renderer) it can't send auth headers, so this endpoint is unauthenticated but
 * bound to 127.0.0.1 only and serves nothing sensitive (a generated cover PNG +
 * a static push page).
 *
 * Lifecycle mirrors the MCP server: started/stopped with the account + settings
 * toggle (see context/app_context.ts). Port-fallback: if the requested port is
 * taken, probe the next N and bind the first free one; the caller persists the
 * real port and rewrites the ARK card to match.
 *
 * Routes:
 *   GET /cover/daily  → PNG (satori/resvg generated "每日推文" card cover)
 *   GET /p/daily      → HTML  (the push page opened on card click)
 *   GET /avatar.png   → PNG (WeQ logo; avatar fallback — main avatar is a local file)
 *   GET /healthz      → 200 "ok"
 */

import http from 'node:http';
import { ipcMain } from 'electron';
import { readFileSync, existsSync } from 'node:fs';
import { getLogger, logErrorContext } from '@weq/service';
import { resolveResource } from '../resource';
import { renderCardPng, dailyCardSpec } from './cover';
import { buildPalette, getWeqTheme, setWeqTheme } from './theme';
import { getWeqStats } from './stats';
import { renderStatsPageHtml, statsPendingHtml, statsCardSpec } from './stats_page';

const logger = getLogger().child({ scope: 'weq-assistant-server' });

export interface WeqServerOptions {
  port: number;
}

const PORT_FALLBACK_ATTEMPTS = 20;

let httpServer: http.Server | null = null;
let activeConfig: WeqServerOptions | null = null;

export function isWeqServerRunning(): boolean {
  return httpServer !== null;
}

/**
 * Register the renderer→main theme pipe. The renderer's `applyTheme` calls this
 * whenever accent / 深浅 changes (and once on hydrate), so the 每日推文 封面 + 跳转页
 * — rendered here in the main process — track WeQ Desktop's theme. Idempotent;
 * safe to call once at startup even before the server is enabled.
 */
export function registerWeqAssistantIpc(): void {
  ipcMain.handle(
    'weqAssistant:set-theme',
    (_event, theme?: { accent?: string; mode?: 'light' | 'dark' }) => {
      setWeqTheme(theme);
      return true;
    },
  );
}

export function runningWeqServerConfig(): WeqServerOptions | null {
  return activeConfig;
}

function todayLabel(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Push page opened when the QQ user taps the card. Handcrafted single page (not
 * the report system) — this is a demo intro today; the push channel will later
 * carry real subscriptions (CLI 日报 / 通知). Colors follow WeQ Desktop's theme
 * via the live snapshot (accent + 深/浅), matching the ARK cover 1:1.
 */
function dailyPageHtml(): string {
  const date = todayLabel();
  const p = buildPalette(getWeqTheme());
  const logo = brandLogoDataUri();
  const logoTag = logo
    ? `<img class="logo" src="${logo}" alt="WeQ" />`
    : '<div class="logo logo--fallback">W</div>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WeQ 助手 · 每日推文</title>
<style>
  :root {
    --accent: ${p.accent};
    --base: ${p.base};
    --glow1: ${p.glow1};
    --glow2: ${p.glow2};
    --grid: ${p.grid};
    --title: ${p.title};
    --body: ${p.body};
    --sub: ${p.sub};
    --tag-bg: ${p.tagBg};
    --tag-ink: ${p.tagInk};
    --pill-bg: ${p.pillBg};
    --pill-border: ${p.pillBorder};
    --pill-ink: ${p.pillInk};
    --accent-ink: ${p.accentInk};
    --card: ${p.mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.72)'};
    --card-border: ${p.mode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.06)'};
    --card-shadow: ${p.mode === 'dark' ? '0 24px 60px -28px rgba(0,0,0,0.7)' : '0 24px 60px -30px rgba(15,23,42,0.28)'};
    color-scheme: ${p.mode};
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", Roboto, system-ui, sans-serif;
    color: var(--body);
    background-color: var(--base);
    background-image:
      radial-gradient(720px 420px at 100% -6%, var(--glow1), transparent),
      radial-gradient(680px 460px at -8% 108%, var(--glow2), transparent),
      linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: auto, auto, 38px 38px, 38px 38px;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 640px; margin: 0 auto; padding: 56px 22px 72px; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  .logo { width: 42px; height: 42px; border-radius: 11px;
          box-shadow: 0 8px 20px -8px var(--accent); }
  .logo--fallback { display: flex; align-items: center; justify-content: center;
          background: var(--accent); color: #fff; font-weight: 800; font-size: 22px; }
  .brand .name { font-size: 18px; font-weight: 700; color: var(--title); }
  .tag { margin-left: auto; font-size: 13px; font-weight: 700; color: var(--tag-ink);
         background: var(--tag-bg); padding: 6px 13px; border-radius: 999px; }
  .card {
    position: relative; overflow: hidden;
    background: var(--card); border: 1px solid var(--card-border);
    border-radius: 22px; padding: 34px 32px;
    box-shadow: var(--card-shadow);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  }
  .card::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg, var(--accent), transparent 70%); }
  h1 { margin: 0; font-size: 30px; line-height: 1.3; color: var(--title); font-weight: 800;
       letter-spacing: -0.01em; }
  .date { display: inline-flex; align-items: center; gap: 8px; margin: 16px 0 22px;
    font-size: 14px; font-weight: 600; color: var(--pill-ink);
    background: var(--pill-bg); border: 1px solid var(--pill-border);
    padding: 7px 14px; border-radius: 999px; }
  .date .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--accent-ink); }
  p { line-height: 1.85; font-size: 15.5px; margin: 0 0 14px; color: var(--body); }
  .card p:last-of-type { margin-bottom: 0; }
  .card b { color: var(--title); font-weight: 700; }
  .feats { display: flex; flex-direction: column; gap: 12px; margin: 24px 0 6px; }
  .feat { display: flex; gap: 12px; align-items: flex-start; }
  .feat .ic { flex: none; width: 30px; height: 30px; border-radius: 9px;
    display: flex; align-items: center; justify-content: center; font-size: 16px;
    background: var(--tag-bg); }
  .feat .ft { font-size: 14.5px; line-height: 1.6; }
  .feat .ft b { color: var(--title); }
  .foot { margin-top: 26px; text-align: center; font-size: 12.5px; color: var(--sub); }
  .foot .lock { opacity: 0.85; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      ${logoTag}
      <span class="name">WeQ 助手</span>
      <span class="tag">每日推文</span>
    </div>
    <div class="card">
      <h1>今天，你的 QQ 会自己写日报</h1>
      <div class="date"><span class="dot"></span>${date} · 本机推送</div>
      <p>这是 WeQ 助手推送的<b>每日推文</b>示例页面。未来这里会渲染日报、日记、订阅摘要等由本地服务生成的内容。</p>
      <div class="feats">
        <div class="feat"><div class="ic">📊</div><div class="ft"><b>每日日报</b> —— 把当天的聊天动态整理成一页摘要，睡前十秒看完。</div></div>
        <div class="feat"><div class="ic">🔔</div><div class="ft"><b>订阅通知</b> —— 关注的人/群有新动态时，主动推一条卡片给你。</div></div>
        <div class="feat"><div class="ic">🔒</div><div class="ft"><b>完全离线</b> —— 消息、封面与本页都来自你本机的 WeQ 服务，不经过任何外部服务器。</div></div>
      </div>
    </div>
    <div class="foot"><span class="lock">🔒</span> Served locally by WeQ · 127.0.0.1</div>
  </div>
</body>
</html>`;
}

/** WeQ logo as a data URI for the push page, or null if the asset is missing. */
let pageLogoUri: string | null | undefined;
function brandLogoDataUri(): string | null {
  if (pageLogoUri !== undefined) return pageLogoUri;
  const path = resolveResource('brand', 'logo.png');
  pageLogoUri = path && existsSync(path)
    ? `data:image/png;base64,${readFileSync(path).toString('base64')}`
    : null;
  return pageLogoUri;
}

function sendPng(res: http.ServerResponse, png: Buffer): void {
  res.writeHead(200, {
    'content-type': 'image/png',
    'cache-control': 'no-cache',
    'content-length': String(png.byteLength),
  });
  res.end(png);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  try {
    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (path === '/cover/daily') {
      const png = await renderCardPng(dailyCardSpec(todayLabel()));
      sendPng(res, png);
      return;
    }
    if (path === '/p/daily' || path === '/p/daily/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dailyPageHtml());
      return;
    }
    // 「群数据周报」推文：封面 + 跳转页都只读内存快照（getWeqStats），零计算；
    // 快照由 app_context 后台算好落盘再灌进内存（见 weq_assistant/stats.ts）。
    if (path === '/cover/stats') {
      const png = await renderCardPng(statsCardSpec(getWeqStats()));
      sendPng(res, png);
      return;
    }
    if (path === '/p/stats' || path === '/p/stats/') {
      const report = getWeqStats();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(report ? renderStatsPageHtml(report) : statsPendingHtml());
      return;
    }
    if (path === '/avatar.png') {
      const logo = resolveResource('brand', 'logo.png');
      if (logo && existsSync(logo)) {
        sendPng(res, readFileSync(logo));
        return;
      }
      notFound(res);
      return;
    }
    notFound(res);
  } catch (error) {
    logger.error('weq-assistant request failed', {
      event: 'weq-request-error',
      path,
      ...logErrorContext(error),
    });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('internal error');
    }
  }
}

function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve(true);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Start (or restart) the WeQ 助手 server. Idempotent for the same port. Probes
 * the next `PORT_FALLBACK_ATTEMPTS` ports if the requested one is busy; returns
 * the port actually bound so the caller can persist it + rewrite the ARK card.
 */
export async function startWeqServer(opts: WeqServerOptions): Promise<number> {
  if (httpServer) {
    if (activeConfig && activeConfig.port === opts.port) return activeConfig.port;
    await stopWeqServer();
  }
  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });
  let boundPort = -1;
  for (let i = 0; i < PORT_FALLBACK_ATTEMPTS; i += 1) {
    const port = opts.port + i;
    if (port > 65535) break;
    if (await tryListen(server, port)) {
      boundPort = port;
      break;
    }
    logger.warn('weq-assistant port in use, trying next', { event: 'weq-port-busy', port });
  }
  if (boundPort === -1) {
    server.close();
    throw new Error(
      `WeQ 助手端口 ${opts.port}–${Math.min(opts.port + PORT_FALLBACK_ATTEMPTS - 1, 65535)} 都被占用，无法启动。`,
    );
  }
  httpServer = server;
  activeConfig = { port: boundPort };
  logger.info('weq-assistant server started', {
    event: 'weq-start',
    port: boundPort,
    requestedPort: opts.port,
    url: `http://127.0.0.1:${boundPort}`,
  });
  return boundPort;
}

/** Stop the server if running. Idempotent. */
export async function stopWeqServer(): Promise<void> {
  const server = httpServer;
  if (!server) return;
  httpServer = null;
  activeConfig = null;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  logger.info('weq-assistant server stopped', { event: 'weq-stop' });
}
