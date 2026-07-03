/**
 * WebUI 单文件前端（内嵌进 bot.mjs，产物零额外文件）。
 *
 * 纯原生 HTML/CSS/JS，无三方库：
 *   - 登录门：输入 hex 密钥 → POST /api/login → 存 sessionStorage → 进主界面。
 *   - 页面①「统计」：token 消耗（总/今日/按模型）、收发消息、按天柱状图、运行时长。
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
<div id="app"></div>
<script>window.__BOT_NAME__ = ${JSON.stringify(botName)};</script>
<script>${JS}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/* ── 样式：复刻 WeQ 令牌 + 浅/深模式 ─────────────────────────────────────── */
const CSS = String.raw`
:root {
  --accent: #0099ff;
  --bg-app: #f4f7fb;
  --bg-surface: #ffffff;
  --bg-elevated: #fbfcfe;
  --fg-primary: #1a2230;
  --fg-secondary: #4a5568;
  --fg-muted: #8a94a6;
  --border-subtle: color-mix(in srgb, var(--accent) 15%, #e4e9f0);
  --border-strong: color-mix(in srgb, var(--accent) 26%, #d3dae4);
  --shadow: 0 1px 2px rgba(20, 30, 50, 0.04), 0 8px 24px rgba(20, 30, 50, 0.06);
  --pos: #22a06b;
  --warn: #e0812b;
  --radius: 14px;
  color-scheme: light;
}
html[data-theme='dark'] {
  --accent: #56a8f7;
  --bg-app: #0f1216;
  --bg-surface: #171b21;
  --bg-elevated: #1c2129;
  --fg-primary: #eef2f7;
  --fg-secondary: #b7c0cd;
  --fg-muted: #7c8798;
  --border-subtle: color-mix(in srgb, var(--accent) 16%, rgba(255, 255, 255, 0.08));
  --border-strong: color-mix(in srgb, var(--accent) 26%, rgba(255, 255, 255, 0.14));
  --shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 10px 30px rgba(0, 0, 0, 0.35);
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
    radial-gradient(1200px 600px at 15% -10%, color-mix(in srgb, var(--accent) 8%, transparent), transparent 60%),
    var(--bg-app);
  min-height: 100%;
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; cursor: pointer; border: none; background: none; color: inherit; }
input { font: inherit; }
svg { display: block; }
.mono { font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace; }

/* ── 登录门 ── */
.login-wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.login-card {
  width: min(400px, 100%); background: var(--bg-surface); border: 1px solid var(--border-subtle);
  border-radius: 20px; padding: 34px 30px; box-shadow: var(--shadow); text-align: center;
}
.login-logo {
  width: 60px; height: 60px; margin: 0 auto 18px; border-radius: 18px; display: grid; place-items: center;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #8a6cff));
  color: #fff; box-shadow: 0 8px 22px color-mix(in srgb, var(--accent) 40%, transparent);
}
.login-card h1 { font-size: 19px; font-weight: 650; letter-spacing: -0.01em; }
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
.shell { max-width: 960px; margin: 0 auto; padding: 22px 22px 60px; }
.topbar { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
.brand { display: flex; align-items: center; gap: 11px; }
.brand-badge {
  width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; color: #fff; flex: none;
  background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #8a6cff));
  box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 30%, transparent);
}
.brand-name { font-size: 16px; font-weight: 650; letter-spacing: -0.01em; }
.brand-sub { font-size: 11.5px; color: var(--fg-muted); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--pos); display: inline-block; margin-right: 5px;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--pos) 22%, transparent); }
.topbar-spacer { flex: 1; }
.icon-btn {
  width: 38px; height: 38px; border-radius: 11px; display: grid; place-items: center; color: var(--fg-secondary);
  border: 1px solid var(--border-subtle); background: var(--bg-surface); transition: background .15s, color .15s;
}
.icon-btn:hover { background: var(--bg-elevated); color: var(--fg-primary); }

.tabs { display: inline-flex; gap: 4px; padding: 4px; margin-bottom: 20px; border-radius: 13px;
  background: var(--bg-surface); border: 1px solid var(--border-subtle); }
.tab {
  display: inline-flex; align-items: center; gap: 7px; padding: 8px 15px; border-radius: 10px; font-size: 13px;
  font-weight: 550; color: var(--fg-secondary); transition: background .15s, color .15s;
}
.tab:hover { color: var(--fg-primary); }
.tab.active { color: #fff; background: linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 72%, #6f7cff));
  box-shadow: 0 4px 12px color-mix(in srgb, var(--accent) 30%, transparent); }

/* ── 卡片 ── */
.grid { display: grid; gap: 14px; }
.grid-4 { grid-template-columns: repeat(4, 1fr); }
.grid-2 { grid-template-columns: repeat(2, 1fr); }
@media (max-width: 720px) { .grid-4 { grid-template-columns: repeat(2, 1fr); } .grid-2 { grid-template-columns: 1fr; } }
.card {
  background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius);
  padding: 17px 18px; box-shadow: var(--shadow);
}
.card-title { font-size: 12.5px; font-weight: 600; color: var(--fg-secondary); display: flex; align-items: center;
  gap: 8px; margin-bottom: 14px; }
.card-title svg { color: var(--accent); }
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat .k { font-size: 12px; color: var(--fg-muted); display: inline-flex; align-items: center; gap: 6px; }
.stat .k svg { color: var(--accent); }
.stat .v { font-size: 25px; font-weight: 680; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.stat .v small { font-size: 13px; font-weight: 500; color: var(--fg-muted); margin-left: 3px; }
.stat .sub { font-size: 11.5px; color: var(--fg-muted); }

/* 图表 */
.chart { display: flex; align-items: flex-end; gap: 6px; height: 150px; padding-top: 8px; }
.bar-col { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 0; }
.bar-stack { width: 100%; max-width: 26px; display: flex; flex-direction: column; justify-content: flex-end;
  height: 118px; border-radius: 6px 6px 3px 3px; overflow: hidden; background: color-mix(in srgb, var(--fg-muted) 8%, transparent); }
.bar-seg { width: 100%; transition: height .4s ease; }
.bar-seg.pt { background: color-mix(in srgb, var(--accent) 42%, transparent); }
.bar-seg.ct { background: var(--accent); }
.bar-x { font-size: 10px; color: var(--fg-muted); white-space: nowrap; }
.legend { display: flex; gap: 16px; margin-top: 12px; font-size: 11.5px; color: var(--fg-secondary); }
.legend i { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-right: 6px; vertical-align: -1px; }

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
.loading { text-align: center; color: var(--fg-muted); padding: 60px 0; font-size: 13px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
`;

/* ── 前端脚本：全部原生，图标用内联 SVG（无 emoji、无三方库） ───────────────── */
const JS = String.raw`
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
      refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>'
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

      // 按天柱状图
      html += '<div class="card" style="margin-top:14px"><div class="card-title">' + ic('chart', 15) + ' 近 14 天 Token 消耗</div>' +
        chart(s.byDay) +
        '<div class="legend"><span><i style="background:color-mix(in srgb,var(--accent) 42%,transparent)"></i>输入</span>' +
        '<span><i style="background:var(--accent)"></i>输出</span></div></div>';

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

  function chart(days) {
    var max = 1;
    days.forEach(function (d) { if (d.totalTokens > max) max = d.totalTokens; });
    var bars = days.map(function (d) {
      var pt = Math.round((d.promptTokens / max) * 118);
      var ct = Math.round((d.completionTokens / max) * 118);
      var label = d.date.slice(5); // MM-DD
      var tip = d.date + ' · ' + fmtInt(d.totalTokens) + ' tokens';
      return '<div class="bar-col" title="' + tip + '"><div class="bar-stack">' +
        '<div class="bar-seg ct" style="height:' + ct + 'px"></div>' +
        '<div class="bar-seg pt" style="height:' + pt + 'px"></div>' +
        '</div><div class="bar-x">' + label + '</div></div>';
    }).join('');
    return '<div class="chart">' + bars + '</div>';
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
      view.innerHTML = html;
    }).catch(function (e) { view.innerHTML = errBox(e); });
  }
  function rowPill(label, on) {
    return '<div class="row"><span class="label">' + esc(label) + '</span>' + pill(!!on, '已开启', '未开启') + '</div>';
  }
  function errBox(e) {
    return '<div class="card"><div class="card-title" style="color:var(--warn)">' + ic('alert', 15) + ' 加载失败</div>' +
      '<div class="prose">' + esc(e && e.message ? e.message : '未知错误') + '</div></div>';
  }

  var BOT_NAME = window.__BOT_NAME__ || 'WeQ Bot';
  initTheme();
  if (sessionStorage.getItem(KEY)) renderMain(); else renderLogin();
})();
`;
