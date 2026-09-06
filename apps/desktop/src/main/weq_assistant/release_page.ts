/**
 * 「版本发布」推文 —— 新 GitHub release 的封面与跳转页渲染 + 发布。
 *
 * 推文内容约定（见仓库根 CHANGELOG.md）：release 的推文正文 = CHANGELOG.md 里
 * 对应版本的章节；封面 / 页面只吃纯文本摘要（第一条 bullet），不解析 Markdown。
 *
 *   /p/release      → <docroot>/p/release.html
 *   /cover/release  → <docroot>/cover/release.png
 *
 * 渲染复用 cover.ts 的 satori/resvg 管线与 publish.ts 的页面模板风格，主题
 * 在渲染时烘焙进产物（守护进程零渲染逻辑）。幂等：同版本重写同路径文件。
 */

import { buildPalette, getWeqTheme } from './theme';
import { renderCardPng, type CardSpec } from './cover';
import { lucide, type LUCIDE_PATHS, publishDocrootFile } from './publish';
import { getLogger } from '@weq/service';

const logger = getLogger().child({ scope: 'weq-assistant-release' });

/** 一条 release 推文的渲染输入（全部纯文本，来自 CHANGELOG 章节 + 版本号）。 */
export interface ReleasePageInput {
  /** 版本号（`0.5.0`，不带 `v` 前缀）。 */
  version: string;
  /** 推文标题，如「WeQ 0.5.0 发布」。 */
  title: string;
  /** 摘要（CHANGELOG 章节的第一条 bullet，纯文本）。 */
  summary: string;
  /** GitHub release 页跳转地址。 */
  releaseUrl: string;
}

/** /p/release 的跳转页 HTML（风格与 daily / stats 页一致）。 */
export function renderReleasePageHtml(input: ReleasePageInput): string {
  const p = buildPalette(getWeqTheme());
  const icon = (name: keyof typeof LUCIDE_PATHS, size: number): string => lucide(name, size);
  const safe = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WeQ 助手 · ${safe(input.title)}</title>
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
  .logo { width: 42px; height: 42px; border-radius: 11px; box-shadow: 0 8px 20px -8px var(--accent); }
  .logo--fallback { display: flex; align-items: center; justify-content: center;
    background: var(--accent); color: #fff; font-weight: 800; font-size: 22px; }
  .brand .name { font-size: 18px; font-weight: 700; color: var(--title); }
  .tag { margin-left: auto; font-size: 13px; font-weight: 700; color: var(--tag-ink);
    background: var(--tag-bg); padding: 6px 13px; border-radius: 999px; }
  .card { position: relative; overflow: hidden; background: var(--card);
    border: 1px solid var(--card-border); border-radius: 22px; padding: 34px 32px;
    box-shadow: 0 24px 60px -28px rgba(0,0,0,0.45); backdrop-filter: blur(10px); }
  .card::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg, var(--accent), transparent 70%); }
  h1 { margin: 0; font-size: 30px; line-height: 1.3; color: var(--title); font-weight: 800; }
  .ver { display: inline-flex; align-items: center; gap: 8px; margin: 16px 0 22px;
    font-size: 14px; font-weight: 600; color: var(--pill-ink);
    background: var(--pill-bg); border: 1px solid var(--pill-border);
    padding: 7px 14px; border-radius: 999px; }
  .ver .dot { width: 7px; height: 7px; border-radius: 999px; background: var(--accent-ink); }
  p { line-height: 1.85; font-size: 15.5px; margin: 0 0 14px; color: var(--body); }
  .cta { display: inline-flex; align-items: center; gap: 8px; margin-top: 10px;
    font-size: 15px; font-weight: 700; color: #fff; background: var(--accent);
    padding: 11px 20px; border-radius: 12px; text-decoration: none; }
  .foot { margin-top: 26px; display: flex; align-items: center; justify-content: center;
    gap: 6px; font-size: 12.5px; color: var(--sub); }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="logo logo--fallback">W</div>
      <span class="name">WeQ 助手</span>
      <span class="tag">版本发布</span>
    </div>
    <div class="card">
      <h1>${safe(input.title)}</h1>
      <div class="ver"><span class="dot"></span>v${safe(input.version)} · 新版本已发布</div>
      <p>${safe(input.summary)}</p>
      <a class="cta" href="${safe(input.releaseUrl)}">${icon('package', 16)} 查看完整发布说明</a>
    </div>
    <div class="foot">${icon('lock', 13)} Served locally by WeQ · localhost.weixin.qq.com</div>
  </div>
</body>
</html>`;
}

/** /cover/release 的封面 CardSpec（交给 cover.renderCardPng）。 */
export function releaseCardSpec(input: ReleasePageInput): CardSpec {
  return {
    title: `WeQ ${input.version} 发布`,
    subtitle: input.summary,
    footer: '点击查看发布说明',
    tag: '版本发布',
  };
}

/**
 * 把 release 页面 / 封面物化到 docroot（幂等）。复用 publish.ts 的落盘通道
 * —— 避免两套「写 docroot」的实现各管各的安全边界。
 */
export async function publishReleasePages(
  docroot: string,
  input: ReleasePageInput,
): Promise<boolean> {
  const writtenPage = publishDocrootFile(docroot, 'p/release.html', renderReleasePageHtml(input));
  try {
    const png = await renderCardPng(releaseCardSpec(input));
    const writtenCover = publishDocrootFile(docroot, 'cover/release.png', png);
    if (writtenPage && writtenCover) return true;
  } catch (error) {
    logger.warn('failed to render release cover', {
      event: 'weq-release-cover-failed',
      version: input.version,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return writtenPage;
}
