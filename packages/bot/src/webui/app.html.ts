/**
 * WebUI 单文件前端（内嵌进 bot.mjs，产物零额外文件）。
 *
 * 纯原生 HTML/CSS/JS，无三方库：
 *   - 登录门：输入 hex 密钥 → POST /api/login → 存 sessionStorage → 进主界面。
 *   - 页面①「统计」：token 消耗（总/今日/按模型）、收发消息、近 24 小时折线图、运行时长。
 *   - 页面②「总览」：训练语料、模型绑定、发言意愿、语音克隆、表情、风格画像。
 *
 * 主题令牌完全复刻 WeQ Desktop（浅/深双模式，localStorage 记忆，默认跟随系统）。
 * 导出 renderAppHtml(botName) → 完整 HTML 字符串（server.ts GET / 时返回）。
 */

export function renderAppHtml(botName: string): string {
  const title = `${escapeHtml(botName)} · 控制台`;
  return `<!doctype html>
<html lang="zh-CN" data-theme="light">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<canvas id="bg-geo" aria-hidden="true"></canvas>
<div id="bg-aurora" aria-hidden="true"></div>
<div id="app"></div>
<script>window.__BOT_NAME__ = ${JSON.stringify(botName)};</script>
<script>${JS}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/* ── 样式：复刻 WeQ 视觉语言（极光 + 几何线 + 玻璃拟态）· 浅/深双模式 ────────── */
const CSS = `
:root {
  --accent: #0099ff;
  /* WeQ 四色极光板（蓝/青绿/暖黄/柔紫），图表与光晕共用 */
  --c-blue: #0099ff;
  --c-teal: #53ce90;
  --c-gold: #f5a623;
  --c-violet: #847ee0;
  --bg-app: #eef3fa;
  --bg-surface: #ffffff;
  --bg-elevated: #fbfcfe;
  --fg-primary: #17202e;
  --fg-secondary: #48566b;
  --fg-muted: #8a94a6;
  --border-subtle: color-mix(in srgb, var(--accent) 15%, #e4e9f0);
  --border-strong: color-mix(in srgb, var(--accent) 26%, #d3dae4);
  --shadow: 0 1px 2px rgba(20, 30, 50, 0.04), 0 10px 30px rgba(20, 30, 50, 0.07);
  --shadow-lg: 0 30px 70px -34px rgba(7, 31, 61, 0.30);
  /* 玻璃卡：半透明面 + 高光描边，让背景极光/几何线透出来 */
  --glass-bg: color-mix(in srgb, var(--bg-surface) 72%, transparent);
  --glass-border: color-mix(in srgb, var(--accent) 18%, rgba(255, 255, 255, 0.6));
  --glass-blur: blur(16px) saturate(1.35);
  --pos: #22a06b;
  --warn: #e0812b;
  --radius: 16px;
  color-scheme: light;
}
html[data-theme='dark'] {
  --accent: #56a8f7;
  --c-blue: #56a8f7;
  --c-teal: #4cc38a;
  --c-gold: #f0a355;
  --c-violet: #9a92f0;
  --bg-app: #0c0f14;
  --bg-surface: #161b22;
  --bg-elevated: #1c2129;
  --fg-primary: #eef2f7;
  --fg-secondary: #b7c0cd;
  --fg-muted: #7c8798;
  --border-subtle: color-mix(in srgb, var(--accent) 16%, rgba(255, 255, 255, 0.08));
  --border-strong: color-mix(in srgb, var(--accent) 26%, rgba(255, 255, 255, 0.14));
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 14px 40px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 34px 80px -30px rgba(0, 0, 0, 0.6);
  --glass-bg: color-mix(in srgb, var(--bg-surface) 64%, transparent);
  --glass-border: color-mix(in srgb, var(--accent) 22%, rgba(255, 255, 255, 0.08));
  --glass-blur: blur(18px) saturate(1.2);
  --pos: #4cc38a;
  --warn: #f0a355;
  color-scheme: dark;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: var(--fg-primary);
  background:
    radial-gradient(ellipse at 14% 12%, color-mix(in srgb, var(--c-blue) 16%, transparent) 0, transparent 44%),
    radial-gradient(ellipse at 82% 10%, color-mix(in srgb, var(--c-gold) 13%, transparent) 0, transparent 40%),
    radial-gradient(ellipse at 86% 84%, color-mix(in srgb, var(--c-teal) 13%, transparent) 0, transparent 44%),
    radial-gradient(ellipse at 24% 90%, color-mix(in srgb, var(--c-violet) 10%, transparent) 0, transparent 46%),
    var(--bg-app);
  min-height: 100%;
  -webkit-font-smoothing: antialiased;
  overflow-x: hidden;
}
/* 动态几何线条画布 + 斜线纹理层（固定铺满、置底，不吃事件） */
#bg-geo {
  position: fixed; inset: 0; width: 100vw; height: 100vh;
  z-index: -2; pointer-events: none; display: block;
}
#bg-aurora {
  position: fixed; inset: 0; z-index: -1; pointer-events: none;
  opacity: 0.5;
  background-image:
    linear-gradient(118deg, transparent 0 22%, color-mix(in srgb, var(--c-blue) 6%, transparent) 22.2% 22.5%, transparent 22.9% 100%),
    linear-gradient(154deg, transparent 0 61%, color-mix(in srgb, var(--c-teal) 5%, transparent) 61.1% 61.4%, transparent 61.8% 100%),
    linear-gradient(72deg, transparent 0 40%, color-mix(in srgb, var(--c-violet) 4%, transparent) 40.2% 40.5%, transparent 41% 100%);
  mask-image: radial-gradient(ellipse at 50% 40%, rgba(0,0,0,0.5), transparent 82%);
}
button { font: inherit; cursor: pointer; border: none; background: none; color: inherit; }
input { font: inherit; }
svg { display: block; }
.mono { font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace; }
@media (prefers-reduced-motion: reduce) { #bg-geo { display: none; } }

/* ── 登录门 ── */
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.login-card {
  position: relative; width: min(400px, 100%); border-radius: 22px; padding: 36px 30px; text-align: center;
  background: var(--glass-bg); border: 1px solid var(--glass-border);
  -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur);
  box-shadow: var(--shadow-lg); overflow: hidden;
  animation: rise-in 520ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
/* 卡内缓慢流转的极光光晕 */
.login-card::before {
  content: ""; position: absolute; inset: -40% -40% auto auto; width: 260px; height: 260px; z-index: 0;
  background: radial-gradient(circle, color-mix(in srgb, var(--c-blue) 34%, transparent), transparent 68%);
  filter: blur(14px); animation: orbit 14s ease-in-out infinite;
}
.login-card::after {
  content: ""; position: absolute; inset: auto auto -40% -40%; width: 240px; height: 240px; z-index: 0;
  background: radial-gradient(circle, color-mix(in srgb, var(--c-teal) 30%, transparent), transparent 68%);
  filter: blur(14px); animation: orbit 16s ease-in-out infinite reverse;
}
.login-card > * { position: relative; z-index: 1; }
.login-logo {
  width: 62px; height: 62px; margin: 0 auto 18px; border-radius: 20px; display: grid; place-items: center;
  background: linear-gradient(135deg, var(--c-blue), color-mix(in srgb, var(--c-violet) 70%, var(--c-blue)));
  color: #fff; box-shadow: 0 10px 26px color-mix(in srgb, var(--accent) 44%, transparent);
  animation: float 3.2s ease-in-out infinite;
}
.login-card h1 { font-size: 20px; font-weight: 680; letter-spacing: -0.01em; }
.login-card .sub { color: var(--fg-muted); font-size: 12.5px; margin-top: 6px; margin-bottom: 22px; }
.field { text-align: left; display: grid; gap: 7px; }
.field label { font-size: 12px; color: var(--fg-secondary); display: inline-flex; align-items: center; gap: 6px; }
.field input {
  width: 100%; height: 42px; padding: 0 13px; border-radius: 11px; border: 1px solid var(--border-subtle);
  background: var(--bg-elevated); color: var(--fg-primary); outline: none; transition: border-color .15s, box-shadow .15s;
}
.field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
.btn-primary {
  margin-top: 18px; width: 100%; height: 42px; border-radius: 11px; font-weight: 600; color: #fff;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 78%, #6f7cff));
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 34%, transparent); transition: transform .1s, filter .15s;
}
.btn-primary:hover { filter: brightness(1.05); }
.btn-primary:active { transform: translateY(1px); }
.btn-primary:disabled { opacity: .6; cursor: default; }
.login-err { color: #e5484d; font-size: 12.5px; margin-top: 12px; min-height: 16px; }

/* ── 主框架 ── */
.shell { max-width: 980px; margin: 0 auto; padding: 26px 22px 64px; }
.topbar {
  position: sticky; top: 12px; z-index: 20; display: flex; align-items: center; gap: 14px; margin-bottom: 22px;
  padding: 10px 14px; border-radius: 16px;
  background: var(--glass-bg); border: 1px solid var(--glass-border);
  -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); box-shadow: var(--shadow);
}
.brand { display: flex; align-items: center; gap: 11px; }
.brand-badge {
  width: 40px; height: 40px; border-radius: 13px; display: grid; place-items: center; color: #fff; flex: none;
  background: linear-gradient(135deg, var(--c-blue), color-mix(in srgb, var(--c-violet) 68%, var(--c-blue)));
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 34%, transparent);
}
.brand-name { font-size: 16px; font-weight: 680; letter-spacing: -0.01em; }
.brand-sub { font-size: 11.5px; color: var(--fg-muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--pos); display: inline-block; margin-right: 5px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pos) 22%, transparent); animation: pulse 2.4s ease-in-out infinite; }
.topbar-spacer { flex: 1; }
.icon-btn {
  width: 38px; height: 38px; border-radius: 12px; display: grid; place-items: center; color: var(--fg-secondary);
  border: 1px solid var(--border-subtle); background: color-mix(in srgb, var(--bg-surface) 60%, transparent);
  transition: background .15s, color .15s, transform .12s; }
.icon-btn:hover { background: var(--bg-elevated); color: var(--accent); transform: translateY(-1px); }
.icon-btn:active { transform: translateY(0); }

.tabs { display: inline-flex; gap: 4px; padding: 4px; margin-bottom: 20px; border-radius: 14px;
  background: var(--glass-bg); border: 1px solid var(--glass-border);
  -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); box-shadow: var(--shadow); }
.tab {
  display: inline-flex; align-items: center; gap: 7px; padding: 8px 16px; border-radius: 11px; font-size: 13px;
  font-weight: 560; color: var(--fg-secondary); transition: background .15s, color .15s;
}
.tab:hover { color: var(--fg-primary); }
.tab.active { color: #fff; background: linear-gradient(135deg, var(--c-blue), color-mix(in srgb, var(--c-violet) 62%, var(--c-blue)));
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 34%, transparent); }

/* ── 卡片 ── */
.grid { display: grid; gap: 14px; }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
.grid-2 { grid-template-columns: repeat(2, 1fr); }
@media (max-width: 720px) { .grid-4 { grid-template-columns: repeat(2, 1fr); } .grid-2 { grid-template-columns: 1fr; } }
.card {
  position: relative; background: var(--glass-bg); border: 1px solid var(--glass-border); border-radius: var(--radius);
  padding: 18px 19px; box-shadow: var(--shadow);
  -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur);
  transition: transform .18s cubic-bezier(0.22, 1, 0.36, 1), box-shadow .18s, border-color .18s;
}
.card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); border-color: var(--border-strong); }
.card-title { font-size: 12.5px; font-weight: 620; color: var(--fg-secondary); display: flex; align-items: center;
  gap: 8px; margin-bottom: 14px; }
.card-title svg { color: var(--accent); }
/* KPI 卡：左侧强调色导轨 + 大号数字 */
.stat { display: flex; flex-direction: column; gap: 5px; overflow: hidden; }
.stat::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
  background: linear-gradient(180deg, var(--c-blue), var(--c-teal)); opacity: .8; }
.stat .k { font-size: 12px; color: var(--fg-muted); display: inline-flex; align-items: center; gap: 6px; }
.stat .k svg { color: var(--accent); }
.stat .v { font-size: 27px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.15; }
.stat .v small { font-size: 13px; font-weight: 500; color: var(--fg-muted); margin-left: 3px; }
.stat .sub { font-size: 11.5px; color: var(--fg-muted); }

/* 24h 折线图 */
.line-wrap { display: flex; gap: 10px; padding-top: 6px; }
.line-yaxis { display: flex; flex-direction: column; justify-content: space-between; height: 150px;
  font-size: 10px; color: var(--fg-muted); text-align: right; min-width: 30px; font-variant-numeric: tabular-nums; }
.line-plot { position: relative; flex: 1; min-width: 0; }
.line-svg { width: 100%; height: 150px; display: block; overflow: visible; }
.line-grid { stroke: color-mix(in srgb, var(--fg-muted) 16%, transparent); stroke-width: 1; }
.line-area { fill: url(#lgArea); }
.line-stroke { stroke: var(--c-blue); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round;
  filter: drop-shadow(0 3px 8px color-mix(in srgb, var(--c-blue) 34%, transparent)); }
.line-dot { fill: var(--bg-surface); stroke: var(--c-blue); stroke-width: 2; cursor: pointer; transition: r .12s; }
.line-dot:hover { r: 5; }
.line-cursor { stroke: color-mix(in srgb, var(--c-blue) 46%, transparent); stroke-width: 1; stroke-dasharray: 3 3; }
.line-axis { display: flex; justify-content: space-between; margin-top: 7px; font-size: 10px; color: var(--fg-muted);
  font-variant-numeric: tabular-nums; }
.line-axis span { flex: 1; text-align: center; }

/* 列表/明细 */
.rows { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 2px;
  border-top: 1px solid var(--border-subtle); }
.row:first-child { border-top: none; }
.row .label { font-size: 13px; color: var(--fg-secondary); display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
.row .label svg { color: var(--fg-muted); flex: none; }
.row .val { font-size: 13px; font-weight: 550; color: var(--fg-primary); text-align: right; font-variant-numeric: tabular-nums;
  overflow: hidden; text-overflow: ellipsis; }
.pill { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; font-size: 11.5px;
  font-weight: 550; border: 1px solid var(--border-subtle); }
.pill.on { color: var(--pos); background: color-mix(in srgb, var(--pos) 12%, transparent);
  border-color: color-mix(in srgb, var(--pos) 30%, transparent); }
.pill.off { color: var(--fg-muted); background: color-mix(in srgb, var(--fg-muted) 10%, transparent); }
.tags { display: flex; flex-wrap: wrap; gap: 7px; }
.tag { font-size: 12px; padding: 4px 10px; border-radius: 8px; color: var(--fg-secondary);
  background: color-mix(in srgb, var(--accent) 9%, transparent); border: 1px solid var(--border-subtle); }
.prose { font-size: 13px; line-height: 1.7; color: var(--fg-secondary); }
.muted-empty { color: var(--fg-muted); font-size: 12.5px; padding: 6px 0; }
.section-h { font-size: 13px; font-weight: 620; margin: 26px 2px 12px; color: var(--fg-primary);
  display: flex; align-items: center; gap: 8px; }
.section-h svg { color: var(--accent); }
.section-h .sh-spacer { flex: 1; }
.sh-btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 10px; font-size: 12px;
  font-weight: 560; color: #fff; background: linear-gradient(135deg, var(--c-blue), color-mix(in srgb, var(--c-violet) 60%, var(--c-blue)));
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 30%, transparent); transition: filter .15s, transform .1s; }
.sh-btn:hover { filter: brightness(1.06); } .sh-btn:active { transform: translateY(1px); } .sh-btn:disabled { opacity: .6; cursor: default; }

/* 表情网格 */
.stk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 12px; }
.stk { position: relative; border: 1px solid var(--border-subtle); border-radius: 13px; overflow: hidden;
  background: color-mix(in srgb, var(--bg-elevated) 70%, transparent); transition: transform .16s, box-shadow .16s, border-color .16s; }
.stk:hover { transform: translateY(-2px); box-shadow: var(--shadow); border-color: var(--border-strong); }
.stk-img { width: 100%; aspect-ratio: 1; object-fit: contain; background:
  conic-gradient(from 45deg, color-mix(in srgb, var(--fg-muted) 6%, transparent) 0 25%, transparent 0 50%) 0 0 / 16px 16px;
  display: block; }
.stk-meta { padding: 8px 10px; }
.stk-desc { font-size: 11.5px; color: var(--fg-secondary); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden; min-height: 32px; }
.stk-foot { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.stk-badge { font-size: 10px; padding: 2px 7px; border-radius: 999px; font-weight: 560; border: 1px solid var(--border-subtle); }
.stk-badge.on { color: var(--pos); background: color-mix(in srgb, var(--pos) 12%, transparent); border-color: color-mix(in srgb, var(--pos) 30%, transparent); }
.stk-badge.rand { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); border-color: color-mix(in srgb, var(--warn) 30%, transparent); }
.stk-count { font-size: 10.5px; color: var(--fg-muted); margin-left: auto; font-variant-numeric: tabular-nums; }
.stk-del { position: absolute; top: 6px; right: 6px; width: 24px; height: 24px; border-radius: 8px; display: grid; place-items: center;
  color: #fff; background: rgba(0,0,0,0.42); opacity: 0; transition: opacity .15s, background .15s; }
.stk:hover .stk-del { opacity: 1; } .stk-del:hover { background: #e5484d; }
.stk-hint { font-size: 11.5px; color: var(--fg-muted); margin: 2px 2px 12px; }
.loading { text-align: center; color: var(--fg-muted); padding: 60px 0; font-size: 13px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── 动效关键帧 ── */
@keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--pos) 22%, transparent); }
  50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--pos) 8%, transparent); } }
@keyframes orbit { 0%, 100% { transform: translate(0, 0) scale(1); } 50% { transform: translate(-24px, 20px) scale(1.14); } }
@keyframes rise-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
/* 进入主界面 / 切页时卡片依次浮现 */
.card, .section-h { animation: rise-in 460ms cubic-bezier(0.22, 1, 0.36, 1) both; }
.grid-4 > .card:nth-child(2) { animation-delay: .04s; }
.grid-4 > .card:nth-child(3) { animation-delay: .08s; }
.grid-4 > .card:nth-child(4) { animation-delay: .12s; }
@media (prefers-reduced-motion: reduce) {
  .card, .section-h, .login-card, .login-logo, .dot { animation: none !important; }
  .card:hover { transform: none; }
}
`;

/* ── 前端脚本：全部原生，图标用内联 SVG（无 emoji、无三方库） ───────────────── */
const JS = `
(function () {
  var app = document.getElementById('app');
  var KEY = 'weq-bot-key';
  var THEME = 'weq-bot-theme';

  // 图标（lucide 同款路径，stroke 走 currentColor）。
  function ic(name, size) {
    var s = size || 16;
    var P = {
      bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
      sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
      moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
      logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
      chart: '<path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="8" rx="1"/><rect x="12" y="6" width="3" height="12" rx="1"/><rect x="17" y="13" width="3" height="5" rx="1"/>',
      grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82"/>',
      arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
      arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
      cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>',
      clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
      key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
      book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14Z"/>',
      brain: '<path d="M12 5a3 3 0 1 0-5.9.6A3 3 0 0 0 4 9a3 3 0 0 0 2 2.8V16a3 3 0 0 0 6 0M12 5a3 3 0 1 1 5.9.6A3 3 0 0 1 20 9a3 3 0 0 1-2 2.8V16a3 3 0 0 1-6 0"/>',
      mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v3"/>',
      gauge: '<path d="M12 14l4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
      sticker: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2Z"/><path d="M14 21v-5a2 2 0 0 1 2-2h5"/>',
      msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
      user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
      hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
      link: '<path d="M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/>',
      alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
      refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
      upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
      trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
      image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.6-3.6a2 2 0 0 0-2.8 0L6 20"/>'
    };
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (P[name] || '') + '</svg>';
  }

  function initTheme() {
    var saved = localStorage.getItem(THEME);
    var sys = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', saved || sys);
  }
  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme');
    var next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(THEME, next);
    var b = document.getElementById('themeBtn');
    if (b) b.innerHTML = ic(next === 'dark' ? 'sun' : 'moon', 17);
  }
  function themeIcon() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon';
  }

  function api(path) {
    return fetch(path, { headers: { Authorization: 'Bearer ' + (sessionStorage.getItem(KEY) || '') } })
      .then(function (r) { if (r.status === 401) { logout(); throw new Error('未授权'); } return r.json(); });
  }
  function logout() { sessionStorage.removeItem(KEY); renderLogin(); }

  function fmt(n) {
    n = n || 0;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }
  function fmtInt(n) { return (n || 0).toLocaleString('en-US'); }
  function dur(ms) {
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + '天 ' + h + '小时';
    if (h > 0) return h + '小时 ' + m + '分';
    return m + '分钟';
  }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  /* ── 登录 ── */
  function renderLogin() {
    app.innerHTML =
      '<div class="login-wrap"><div class="login-card">' +
        '<div class="login-logo">' + ic('bot', 30) + '</div>' +
        '<h1>' + esc(BOT_NAME) + '</h1>' +
        '<div class="sub">克隆体 Bot · 控制台</div>' +
        '<div class="field"><label>' + ic('key', 13) + ' 访问密钥</label>' +
          '<input id="pw" class="mono" type="password" placeholder="粘贴导出时生成的 hex 密钥" autocomplete="off" /></div>' +
        '<button id="go" class="btn-primary">进入控制台</button>' +
        '<div id="err" class="login-err"></div>' +
        '<button id="themeBtn2" class="icon-btn" style="margin:16px auto 0">' + ic(themeIcon(), 17) + '</button>' +
      '</div></div>';
    var pw = document.getElementById('pw'), go = document.getElementById('go'), err = document.getElementById('err');
    document.getElementById('themeBtn2').onclick = function () { toggleTheme(); this.innerHTML = ic(themeIcon(), 17); };
    function submit() {
      var v = pw.value.trim();
      if (!v) { pw.focus(); return; }
      go.disabled = true; go.textContent = '验证中…'; err.textContent = '';
      fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: v }) })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.ok) { sessionStorage.setItem(KEY, v); renderMain(); }
          else { err.textContent = '密钥不正确，请检查后重试。'; go.disabled = false; go.textContent = '进入控制台'; pw.select(); }
        })
        .catch(function () { err.textContent = '无法连接到 bot，请确认进程在运行。'; go.disabled = false; go.textContent = '进入控制台'; });
    }
    go.onclick = submit;
    pw.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
    pw.focus();
  }

  function doReload() {
    var btn = document.getElementById('reloadBtn');
    if (!btn || btn.getAttribute('data-busy')) return;
    if (!window.confirm('用当前 config.json 完全重载？bot 会短暂断线后自动用新配置重连。')) return;
    btn.setAttribute('data-busy', '1');
    btn.innerHTML = ic('refresh', 17).replace('<svg', '<svg class="spin"');
    fetch('/api/reload', { method: 'POST', headers: { Authorization: 'Bearer ' + (sessionStorage.getItem(KEY) || '') } })
      .then(function (r) { return r.json(); })
      .then(function () {
        // 重载会重启 http server，稍等后重连并刷新数据。
        setTimeout(function () { btn.removeAttribute('data-busy'); btn.innerHTML = ic('refresh', 17); route(); }, 2500);
      })
      .catch(function () {
        setTimeout(function () { btn.removeAttribute('data-busy'); btn.innerHTML = ic('refresh', 17); }, 2500);
      });
  }

  /* ── 主界面 ── */
  var activeTab = 'stats';
  function renderMain() {
    app.innerHTML =
      '<div class="shell">' +
        '<div class="topbar">' +
          '<div class="brand"><div class="brand-badge">' + ic('bot', 22) + '</div>' +
            '<div><div class="brand-name">' + esc(BOT_NAME) + '</div>' +
            '<div class="brand-sub"><span class="dot"></span>在线 · 克隆体控制台</div></div></div>' +
          '<div class="topbar-spacer"></div>' +
          '<button id="reloadBtn" class="icon-btn" title="重载配置（用新 config.json 完全重载）">' + ic('refresh', 17) + '</button>' +
          '<button id="themeBtn" class="icon-btn" title="切换主题">' + ic(themeIcon(), 17) + '</button>' +
          '<button id="logoutBtn" class="icon-btn" title="退出">' + ic('logout', 17) + '</button>' +
        '</div>' +
        '<div class="tabs">' +
          '<button class="tab" data-tab="stats">' + ic('chart', 15) + ' 统计</button>' +
          '<button class="tab" data-tab="overview">' + ic('grid', 15) + ' 总览</button>' +
        '</div>' +
        '<div id="view"></div>' +
      '</div>';
    document.getElementById('themeBtn').onclick = toggleTheme;
    document.getElementById('logoutBtn').onclick = logout;
    document.getElementById('reloadBtn').onclick = doReload;
    var tabs = app.querySelectorAll('.tab');
    tabs.forEach(function (t) {
      t.onclick = function () { activeTab = t.getAttribute('data-tab'); syncTabs(); route(); };
    });
    syncTabs(); route();
  }
  function syncTabs() {
    app.querySelectorAll('.tab').forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-tab') === activeTab);
    });
  }
  function route() {
    var view = document.getElementById('view');
    view.innerHTML = '<div class="loading">' + ic('clock', 22) + '<div style="margin-top:10px">加载中…</div></div>';
    if (activeTab === 'stats') loadStats(view); else loadOverview(view);
  }

  /* ── 页面①统计 ── */
  function loadStats(view) {
    api('/api/stats').then(function (s) {
      var today = s.byDay[s.byDay.length - 1] || { totalTokens: 0, messagesIn: 0, messagesOut: 0 };
      var cards =
        statCard('coins', 'Token 总消耗', fmt(s.totals.totalTokens), fmtInt(s.totals.totalTokens) + ' tokens') +
        statCard('cpu', '今日 Token', fmt(today.totalTokens), s.totals.llmCalls + ' 次调用累计') +
        statCard('arrowDown', '收到消息', fmtInt(s.totals.messagesIn), '今日 ' + (today.messagesIn || 0)) +
        statCard('arrowUp', '发出消息', fmtInt(s.totals.messagesOut), '今日 ' + (today.messagesOut || 0));

      var html = '<div class="grid grid-4">' + cards + '</div>';

      // 运行时长 + 输入/输出 token 拆分
      html += '<div class="grid grid-2" style="margin-top:14px">';
      html += '<div class="card"><div class="card-title">' + ic('coins', 15) + ' Token 构成</div>' +
        row('arrowUp', '输入（prompt）', fmtInt(s.totals.promptTokens)) +
        row('arrowDown', '输出（completion）', fmtInt(s.totals.completionTokens)) +
        row('hash', 'LLM 调用次数', fmtInt(s.totals.llmCalls)) +
        row('brain', '生成回复轮数', fmtInt(s.totals.repliesGenerated)) + '</div>';
      html += '<div class="card"><div class="card-title">' + ic('clock', 15) + ' 运行状态</div>' +
        row('clock', '本次已运行', dur(s.now - s.startedAt)) +
        row('clock', '累计起始', new Date(s.firstStartedAt).toLocaleDateString('zh-CN')) +
        row('msg', '收发合计', fmtInt(s.totals.messagesIn + s.totals.messagesOut)) + '</div>';
      html += '</div>';

      // 近 24 小时 Token 折线图
      html += '<div class="card" style="margin-top:14px"><div class="card-title">' + ic('chart', 15) + ' 近 24 小时 Token 消耗</div>' +
        hourLine(s.byHour || []) + '</div>';

      // 按模型
      html += '<div class="section-h">' + ic('cpu', 15) + ' 按模型消耗</div>';
      if (s.byModel.length === 0) {
        html += '<div class="card"><div class="muted-empty">还没有 LLM 调用记录。</div></div>';
      } else {
        html += '<div class="card"><div class="rows">';
        s.byModel.forEach(function (m) {
          html += '<div class="row"><span class="label">' + ic('cpu', 14) + '<span class="mono">' + esc(m.model) + '</span></span>' +
            '<span class="val">' + fmtInt(m.totalTokens) + ' tok · ' + m.calls + ' 次</span></div>';
        });
        html += '</div></div>';
      }
      view.innerHTML = html;
    }).catch(function (e) { view.innerHTML = errBox(e); });
  }

  // 近 24 小时 token 折线图（面积 + 折线 + 网格 + 每点原生 tooltip）。byHour: [{hour,tokens,calls}]。
  function hourLine(byHour) {
    var W = 560, H = 140, PX = 6, PY = 10;
    var max = 1;
    byHour.forEach(function (d) { if (d.tokens > max) max = d.tokens; });
    var n = byHour.length || 1;
    var stepX = (W - PX * 2) / Math.max(1, n - 1);
    var pts = byHour.map(function (d, i) {
      var x = PX + i * stepX;
      var y = PY + (1 - d.tokens / max) * (H - PY * 2);
      return [x, y];
    });
    var line = pts.map(function (p, i) { return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var last = pts[pts.length - 1] || [PX, H - PY];
    var first = pts[0] || [PX, H - PY];
    var area = line + ' L' + last[0].toFixed(1) + ',' + (H - PY) + ' L' + first[0].toFixed(1) + ',' + (H - PY) + ' Z';
    var grid = [0, 0.25, 0.5, 0.75, 1].map(function (t) {
      var y = PY + (H - PY * 2) * t;
      return '<line class="line-grid" x1="' + PX + '" x2="' + (W - PX) + '" y1="' + y + '" y2="' + y + '"></line>';
    }).join('');
    var dots = pts.map(function (p, i) {
      var d = byHour[i];
      var tip = d.hour + ' · ' + fmtInt(d.tokens) + ' tokens · ' + d.calls + ' 次调用';
      return '<circle class="line-dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="3">' +
        '<title>' + esc(tip) + '</title></circle>';
    }).join('');
    var svg =
      '<svg class="line-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="近24小时token折线">' +
      '<defs><linearGradient id="lgArea" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="var(--c-blue)" stop-opacity="0.28"></stop>' +
      '<stop offset="1" stop-color="var(--c-blue)" stop-opacity="0"></stop>' +
      '</linearGradient></defs>' +
      grid +
      '<path class="line-area" d="' + area + '"></path>' +
      '<path class="line-stroke" fill="none" d="' + line + '"></path>' +
      dots +
      '</svg>';
    // 左侧 Y 轴（max / 半 / 0）
    var yaxis = '<div class="line-yaxis"><span>' + fmt(max) + '</span><span>' + fmt(Math.round(max / 2)) + '</span><span>0</span></div>';
    // 底部 X 轴：每 4 小时显示一个时刻标签，与点对齐。
    var xaxis = '<div class="line-axis">' + byHour.map(function (d, i) {
      return '<span>' + (i % 4 === 0 ? esc(d.hour.slice(0, 2)) : '') + '</span>';
    }).join('') + '</div>';
    return '<div class="line-wrap">' + yaxis + '<div class="line-plot">' + svg + xaxis + '</div></div>';
  }

  function statCard(icon, k, v, sub) {
    return '<div class="card stat"><span class="k">' + ic(icon, 14) + esc(k) + '</span>' +
      '<span class="v">' + v + '</span><span class="sub">' + esc(sub) + '</span></div>';
  }
  function row(icon, label, val) {
    return '<div class="row"><span class="label">' + ic(icon, 14) + esc(label) + '</span><span class="val">' + esc(val) + '</span></div>';
  }
  function pill(on, textOn, textOff) {
    return on ? '<span class="pill on">' + esc(textOn) + '</span>' : '<span class="pill off">' + esc(textOff) + '</span>';
  }

  /* ── 页面②总览 ── */
  function loadOverview(view) {
    api('/api/overview').then(function (o) {
      var html = '';
      // 概况卡
      html += '<div class="grid grid-4">' +
        statCard('book', '训练语料', fmtInt(o.corpus.corpusMessageCount), o.corpus.pairCount + ' 组问答对') +
        statCard('hash', '语料字数', fmt(o.corpus.corpusChars), '平均每句 ' + o.corpus.avgFriendMsgChars + ' 字') +
        statCard('sticker', '表情包', fmtInt(o.assets.stickerCount), o.assets.systemFaceCount + ' 个系统表情') +
        statCard('user', '来源', esc(o.persona.sourceKind === 'group' ? '群聊' : '好友'), esc(o.persona.sourceTitle || '—')) +
      '</div>';

      // 模型绑定
      html += '<div class="section-h">' + ic('cpu', 15) + ' 模型绑定</div><div class="card"><div class="rows">';
      html += row('brain', '对话模型', o.models.chat || '—');
      if (o.models.embedding) html += row('hash', '向量模型', o.models.embedding);
      if (o.models.vision) html += row('grid', '视觉模型', o.models.vision);
      html += '</div></div>';

      // 发言意愿 + 语音
      html += '<div class="grid grid-2" style="margin-top:0">';
      html += '<div class="card"><div class="card-title">' + ic('gauge', 15) + ' 发言意愿</div>' +
        row('gauge', '意愿档位', o.willing.level + ' / 100') +
        rowPill('被@必回', o.willing.mustReplyOnMention) +
        rowPill('私聊也按意愿', o.willing.gatePrivate) +
        rowPill('参与群聊', o.features.groupChat) + '</div>';

      var voiceRows = rowPill('语音克隆', o.voice.cloneEnabled && o.features.voice);
      if (o.voice.provider) voiceRows += row('mic', 'TTS 服务商', o.voice.provider);
      if (o.voice.cloneEnabled) voiceRows += row('mic', '音色方式', o.voice.mode === 'clone' ? '复刻 TA 的声音' : '预置音色');
      voiceRows += row('mic', '语音占比', Math.round((o.voice.voiceRatio || 0) * 100) + '%');
      html += '<div class="card"><div class="card-title">' + ic('mic', 15) + ' 语音</div>' + voiceRows + '</div>';
      html += '</div>';

      // 风格画像
      html += '<div class="section-h">' + ic('brain', 15) + ' 风格画像</div><div class="card">';
      if (o.profile.styleSummary) html += '<div class="prose">' + esc(o.profile.styleSummary) + '</div>';
      else html += '<div class="muted-empty">未提取到风格摘要。</div>';
      if (o.profile.topTerms && o.profile.topTerms.length) {
        html += '<div class="tags" style="margin-top:14px">' +
          o.profile.topTerms.slice(0, 24).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>';
      }
      html += '</div>';

      if (o.profile.relationshipSummary) {
        html += '<div class="section-h">' + ic('user', 15) + ' 关系画像</div>' +
          '<div class="card"><div class="prose">' + esc(o.profile.relationshipSummary) + '</div></div>';
      }
      // 自定义表情区（缩略图 + 上传 + 删除）；数据走独立 /api/stickers，异步填充。
      html += '<div id="stkSection"></div>';
      view.innerHTML = html;
      loadStickers();
    }).catch(function (e) { view.innerHTML = errBox(e); });
  }

  /* ── 自定义表情：查看 / 上传 / 删除 ── */
  function loadStickers() {
    var box = document.getElementById('stkSection');
    if (!box) return;
    api('/api/stickers').then(function (r) {
      var list = r.stickers || [];
      var head = '<div class="section-h">' + ic('sticker', 15) + ' 自定义表情' +
        '<span class="sh-spacer"></span>' +
        '<button id="stkUp" class="sh-btn">' + ic('upload', 13) + ' 上传表情</button></div>';
      var hint = r.canDescribe
        ? '本机已配图像模型：上传后会自动解析表情内容，克隆体按语义精准挑选发送。'
        : '未配置图像模型：新上传的表情没有文字说明，克隆体只能在想活跃气氛时“随机发”。可在导出时选一个图像模型来启用精准解析。';
      var grid;
      if (list.length === 0) {
        grid = '<div class="card"><div class="muted-empty">还没有自定义表情，点右上角「上传表情」添加。</div></div>';
      } else {
        grid = '<div class="stk-grid">' + list.map(function (s) {
          var src = '/api/sticker/' + encodeURIComponent(s.md5) + '?k=' + encodeURIComponent(sessionStorage.getItem(KEY) || '');
          var badge = s.described
            ? '<span class="stk-badge on">已解析</span>'
            : '<span class="stk-badge rand">随机发</span>';
          var desc = s.described ? esc(s.description || s.scenario) : '未解析 · 无文字说明';
          return '<div class="stk" data-md5="' + esc(s.md5) + '">' +
            '<button class="stk-del" title="删除">' + ic('trash', 13) + '</button>' +
            '<img class="stk-img" src="' + src + '" alt="表情" loading="lazy" />' +
            '<div class="stk-meta"><div class="stk-desc">' + desc + '</div>' +
            '<div class="stk-foot">' + badge + '<span class="stk-count">发过 ' + (s.count || 0) + ' 次</span></div></div></div>';
        }).join('') + '</div>';
      }
      box.innerHTML = head + '<div class="stk-hint">' + esc(hint) + '</div>' + grid;
      var up = document.getElementById('stkUp');
      if (up) up.onclick = pickStickerFile;
      box.querySelectorAll('.stk-del').forEach(function (btn) {
        btn.onclick = function () {
          var card = btn.closest('.stk');
          if (card) deleteSticker(card.getAttribute('data-md5'));
        };
      });
    }).catch(function () { box.innerHTML = ''; });
  }

  function pickStickerFile() {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      if (f.size > 8 * 1024 * 1024) { window.alert('图片太大了（上限 8MB）。'); return; }
      var reader = new FileReader();
      reader.onload = function () { uploadSticker(String(reader.result || '')); };
      reader.readAsDataURL(f);
    };
    inp.click();
  }

  function uploadSticker(dataUrl) {
    if (!dataUrl) return;
    var up = document.getElementById('stkUp');
    if (up) { up.disabled = true; up.innerHTML = ic('refresh', 13).replace('<svg', '<svg class="spin"') + ' 上传中…'; }
    fetch('/api/stickers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (sessionStorage.getItem(KEY) || '') },
      body: JSON.stringify({ dataUrl: dataUrl }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j.ok) throw new Error(res.j && res.j.error ? res.j.error : '上传失败');
        loadStickers();
      })
      .catch(function (e) {
        if (up) { up.disabled = false; up.innerHTML = ic('upload', 13) + ' 上传表情'; }
        window.alert(e && e.message ? e.message : '上传失败');
      });
  }

  function deleteSticker(md5) {
    if (!md5 || !window.confirm('删除这张表情？克隆体将不再发送它。')) return;
    fetch('/api/stickers/' + encodeURIComponent(md5), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + (sessionStorage.getItem(KEY) || '') },
    }).then(function (r) {
      if (r.status === 401) { logout(); return; }
      loadStickers();
    }).catch(function () { loadStickers(); });
  }
  function rowPill(label, on) {
    return '<div class="row"><span class="label">' + esc(label) + '</span>' + pill(!!on, '已开启', '未开启') + '</div>';
  }
  function errBox(e) {
    return '<div class="card"><div class="card-title" style="color:var(--warn)">' + ic('alert', 15) + ' 加载失败</div>' +
      '<div class="prose">' + esc(e && e.message ? e.message : '未知错误') + '</div></div>';
  }

  /* ── 动态几何线条背景（星座网络：节点缓慢漂移 + 近邻连线，随主题换色） ── */
  function initBg() {
    var cv = document.getElementById('bg-geo');
    if (!cv) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var ctx = cv.getContext('2d');
    if (!ctx) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var W = 0, H = 0, nodes = [], rgb = [0, 153, 255], mouse = { x: -1, y: -1 };

    // 从当前主题的强调色取 RGB（供线条/节点着色）。
    function readAccent() {
      var hex = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0099ff';
      var m = hex.replace('#', '');
      if (m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
      var n = parseInt(m, 16);
      if (!isNaN(n)) rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    function resize() {
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 节点数随面积缩放（上限保守，弱机也顺）。
      var target = Math.max(28, Math.min(72, Math.round((W * H) / 26000)));
      nodes = [];
      for (var i = 0; i < target; i++) {
        nodes.push({
          x: Math.random() * W, y: Math.random() * H,
          vx: (Math.random() - 0.5) * 0.22, vy: (Math.random() - 0.5) * 0.22,
          r: 1 + Math.random() * 1.6,
        });
      }
    }
    var LINK = 140; // 连线阈值（px）
    function frame() {
      ctx.clearRect(0, 0, W, H);
      var i, j, a, b, dx, dy, dist, alpha;
      for (i = 0; i < nodes.length; i++) {
        a = nodes[i];
        a.x += a.vx; a.y += a.vy;
        if (a.x < 0 || a.x > W) a.vx *= -1;
        if (a.y < 0 || a.y > H) a.vy *= -1;
      }
      // 近邻连线
      for (i = 0; i < nodes.length; i++) {
        a = nodes[i];
        for (j = i + 1; j < nodes.length; j++) {
          b = nodes[j];
          dx = a.x - b.x; dy = a.y - b.y; dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < LINK) {
            alpha = (1 - dist / LINK) * 0.28;
            ctx.strokeStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha.toFixed(3) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      }
      // 鼠标牵引连线（靠近指针的节点亮起）
      if (mouse.x >= 0) {
        for (i = 0; i < nodes.length; i++) {
          a = nodes[i];
          dx = a.x - mouse.x; dy = a.y - mouse.y; dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 180) {
            alpha = (1 - dist / 180) * 0.4;
            ctx.strokeStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + alpha.toFixed(3) + ')';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
          }
        }
      }
      // 节点
      for (i = 0; i < nodes.length; i++) {
        a = nodes[i];
        ctx.fillStyle = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.5)';
        ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2); ctx.fill();
      }
      raf = window.requestAnimationFrame(frame);
    }
    var raf = 0;
    readAccent(); resize();
    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
    window.addEventListener('mouseout', function () { mouse.x = -1; mouse.y = -1; });
    // 主题切换（data-theme 变化）→ 重取强调色。
    new MutationObserver(readAccent).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    frame();
  }

  var BOT_NAME = window.__BOT_NAME__ || 'WeQ Bot';
  initTheme();
  initBg();
  if (sessionStorage.getItem(KEY)) renderMain(); else renderLogin();
})();
`;
