/**
 * WeQ 助手推文「发布」—— 把每条推物化成 docroot 下的静态文件。
 *
 * 守护进程（weq-daemon）只是个「端口 + 目录」的静态文件服务器，路由 1:1 对应
 * 推文的 `coverPath` / `pagePath`（见 daemon httpd.rs）：
 *
 *   /p/daily        → <docroot>/p/daily.html
 *   /cover/daily    → <docroot>/cover/daily.png   （无扩展名请求由 httpd 补 .png/.html）
 *   /p/stats        → <docroot>/p/stats.html
 *   /cover/stats    → <docroot>/cover/stats.png
 *   /avatar.png     → <docroot>/avatar.png
 *
 * 渲染函数全部来自原 server.ts 时代的纯函数（satori/resvg + HTML 字符串拼接，
 * 零 Electron 依赖），主题在渲染时烘焙进产物 —— 守护进程不读任何配置。
 * 主题变更 / 统计快照刷新后重新调用 {@link publishWeqAssistantDocroot} 即可。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, sep } from 'node:path';

import { renderCardPng, dailyCardSpec } from './cover';
import { buildPalette, getWeqTheme } from './theme';
import { getWeqStats } from './stats';
import { renderStatsPageHtml, statsPendingHtml, statsCardSpec } from './stats_page';
import { resolveResource } from '../resource';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'weq-assistant-publish' });

function todayLabel(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ── 页面渲染（自 server.ts 原样迁移） ─────────────────────────────────────
// 原实现内联在 HTTP handler 里；守护进程模式下没有 handler，这里改成纯函数。

/**
 * Inline lucide icons (paths copied verbatim from `lucide-react@0.469`). The push
 * page is a plain HTML string — we can't mount React components — so we emit the
 * same SVG the component library would, keeping the icons consistent with WeQ
 * Desktop's UI. `currentColor` lets CSS tint them.
 */
export const LUCIDE_PATHS: Record<string, string> = {
  smartphone: '<rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/>',
  'refresh-cw':
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  package:
    '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/>' +
    '<path d="M12 22V12"/><path d="m3.3 7 7.703 4.734a2 2 0 0 0 1.994 0L20.7 7"/><path d="m7.5 4.27 9 5.15"/>',
  'shield-check':
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>' +
    '<path d="m9 12 2 2 4-4"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
};
export function lucide(name: keyof typeof LUCIDE_PATHS, size: number): string {
  return (
    `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ` +
    `aria-hidden="true">${LUCIDE_PATHS[name]}</svg>`
  );
}

/** WeQ logo as a data URI for the push page, or null if the asset is missing. */
let pageLogoUri: string | null | undefined;
function brandLogoDataUri(): string | null {
  if (pageLogoUri !== undefined) return pageLogoUri;
  const path = resolveResource('brand', 'logo.png');
  pageLogoUri =
    path && existsSync(path)
      ? `data:image/png;base64,${readFileSync(path).toString('base64')}`
      : null;
  return pageLogoUri;
}

/**
 * Push page opened when the QQ user taps the 「每日推文」 card. Colors follow
 * WeQ Desktop's theme via the live snapshot (accent + 深/浅), matching the ARK
 * cover 1:1.
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
<title>WeQ 助手 · 欢迎使用</title>
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
    display: flex; align-items: center; justify-content: center;
    color: var(--tag-ink); background: var(--tag-bg); }
  .feat .ft { font-size: 14.5px; line-height: 1.6; }
  .feat .ft b { color: var(--title); }
  .foot { margin-top: 26px; display: flex; align-items: center; justify-content: center;
    gap: 6px; font-size: 12.5px; color: var(--sub); }
  .foot .ico { opacity: 0.85; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      ${logoTag}
      <span class="name">WeQ 助手</span>
      <span class="tag">欢迎使用</span>
    </div>
    <div class="card">
      <h1>欢迎使用 WeQ！</h1>
      <div class="date"><span class="dot"></span>${date} · 本机运行</div>
      <p><b>WeQ</b> 是一个 NTQQ 自主的<b>本地消息数据库</b>解密、解析与导出工具。所有解密、解析与展示都在你本机完成，消息、封面与本页都来自你自己的 WeQ 服务。</p>
      <div class="feats">
        <div class="feat"><div class="ic">${lucide('smartphone', 18)}</div><div class="ft"><b>高仿 QQ 界面</b> —— 聊天列表、联系人等核心界面高度还原，全消息类型适配。</div></div>
        <div class="feat"><div class="ic">${lucide('refresh-cw', 18)}</div><div class="ft"><b>实时更新</b> —— 外部监听数据库，消息变更时增量更新；支持媒体下载与查看。</div></div>
        <div class="feat"><div class="ic">${lucide('package', 18)}</div><div class="ft"><b>多格式导出</b> —— TXT / JSON / JSONL / SQLite / CSV / XLSX，以及群相册批量下载。</div></div>
        <div class="feat"><div class="ic">${lucide('shield-check', 18)}</div><div class="ft"><b>完全离线</b> —— 不经过任何外部服务器，仅用于个人数据的本地备份与分析。</div></div>
      </div>
    </div>
    <div class="foot">${lucide('lock', 13)} Served locally by WeQ · localhost.weixin.qq.com</div>
  </div>
</body>
</html>`;
}

// ── 落盘 ──────────────────────────────────────────────────────────────────

/** docroot 内的安全写入路径；越界（`..` 等）返回 null。 */
function safeDocrootPath(docroot: string, route: string): string | null {
  const cleaned = route.split('?')[0] ?? '';
  const rel = normalize(cleaned).replaceAll('\\', '/');
  const full = normalize(join(docroot, rel));
  const rootWithSep = normalize(docroot.endsWith(sep) ? docroot : docroot + sep);
  if (!full.startsWith(rootWithSep)) return null;
  return full;
}

/**
 * 把单个文件安全地写进 docroot（新版本更新推文等外部发布方共用同一安全边界）。
 * 返回是否成功写入。
 */
export function publishDocrootFile(docroot: string, route: string, data: string | Buffer): boolean {
  return writeFile(docroot, route, data);
}

function writeFile(docroot: string, route: string, data: string | Buffer): boolean {
  const path = safeDocrootPath(docroot, route);
  if (!path) {
    logger.warn('refusing to write outside docroot', { event: 'weq-publish-escape', route });
    return false;
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data);
    return true;
  } catch (error) {
    logger.warn('failed to write published file', {
      event: 'weq-publish-write-failed',
      route,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface PublishOptions {
  /** docroot 绝对路径（由调用方从设置 / appDataRoot 派生）。 */
  docroot: string;
  /** 群数据周报统计快照缺失时也发布「生成中」占位页（默认 true）。 */
  includeStats?: boolean;
}

/**
 * 把当前主题 + 当前统计快照下的全部推文页面 / 封面物化到 docroot。
 * 幂等：内容不变时重写同路径文件，QQ 侧 `cache-control: no-cache` 保证即时生效。
 * 返回成功写入的路由数。
 */
export async function publishWeqAssistantDocroot(opts: PublishOptions): Promise<number> {
  const { docroot, includeStats = true } = opts;
  let written = 0;

  // 每日推文（欢迎页）
  if (writeFile(docroot, 'p/daily.html', dailyPageHtml())) written += 1;
  try {
    if (writeFile(docroot, 'cover/daily.png', await renderCardPng(dailyCardSpec(todayLabel()))))
      written += 1;
  } catch (error) {
    // 字体缺失等渲染失败不应阻断其它产物的发布。
    logger.warn('failed to render daily cover', {
      event: 'weq-publish-cover-failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // 群数据周报（有快照出完整页，无快照出「生成中」占位）
  if (includeStats) {
    const report = getWeqStats();
    if (
      writeFile(docroot, 'p/stats.html', report ? renderStatsPageHtml(report) : statsPendingHtml())
    )
      written += 1;
    try {
      if (writeFile(docroot, 'cover/stats.png', await renderCardPng(statsCardSpec(report))))
        written += 1;
    } catch (error) {
      logger.warn('failed to render stats cover', {
        event: 'weq-publish-cover-failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // logo（会话头像兜底）
  const logoPath = resolveResource('brand', 'logo.png');
  if (logoPath && existsSync(logoPath)) {
    if (writeFile(docroot, 'avatar.png', readFileSync(logoPath))) written += 1;
  }

  logger.info('published weq assistant docroot', {
    event: 'weq-publish',
    docroot,
    written,
  });
  return written;
}
