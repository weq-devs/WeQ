/**
 * Login page — the only HTML served before authentication.
 *
 * Deliberately self-contained (no bundle, no assets): everything reachable
 * pre-auth is attack surface, so the pre-auth surface is exactly this string
 * plus `POST /_auth/login`.
 */

export const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>WeQ · 登录</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: radial-gradient(120% 120% at 50% 0%, #16212e 0%, #0d1117 55%);
    color: #e6edf3;
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  form {
    width: min(360px, calc(100vw - 48px));
    padding: 32px 28px;
    background: #161b22cc;
    border: 1px solid #30363d;
    border-radius: 14px;
    backdrop-filter: blur(8px);
  }
  h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: .5px; }
  p.hint { margin: 0 0 22px; color: #8b949e; font-size: 13px; }
  label { display: block; margin-bottom: 8px; font-size: 13px; color: #8b949e; }
  input {
    width: 100%; padding: 10px 12px; font-size: 15px; font-family: inherit;
    background: #0d1117; color: #e6edf3;
    border: 1px solid #30363d; border-radius: 8px;
  }
  input:focus { outline: none; border-color: #2f81f7; }
  button {
    width: 100%; margin-top: 16px; padding: 10px; font-size: 15px; font-family: inherit;
    background: #1f6feb; color: #fff; border: 0; border-radius: 8px; cursor: pointer;
  }
  button:hover { background: #2f81f7; }
  button:disabled { opacity: .6; cursor: default; }
  .err { margin-top: 14px; min-height: 20px; color: #f85149; font-size: 13px; }
</style>
</head>
<body>
<form id="f">
  <h1>WeQ</h1>
  <p class="hint">请输入访问令牌以继续。</p>
  <label for="t">访问令牌</label>
  <input id="t" type="password" autocomplete="current-password" autofocus />
  <button id="b" type="submit">进入</button>
  <div class="err" id="e"></div>
</form>
<script>
  const f = document.getElementById('f');
  const t = document.getElementById('t');
  const b = document.getElementById('b');
  const e = document.getElementById('e');
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    e.textContent = '';
    b.disabled = true;
    b.textContent = '验证中…';
    try {
      const res = await fetch('/_auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t.value }),
      });
      if (res.ok) { location.replace('/'); return; }
      e.textContent = res.status === 429 ? '尝试过于频繁，请稍候。' : '令牌不正确。';
    } catch {
      e.textContent = '无法连接服务器。';
    }
    b.disabled = false;
    b.textContent = '进入';
    t.select();
  });
</script>
</body>
</html>`;
