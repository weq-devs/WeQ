/**
 * Login page — the only HTML served before authentication.
 *
 * Deliberately self-contained (no bundle, no assets, no network): everything
 * reachable pre-auth is attack surface, so the pre-auth surface is exactly this
 * string plus `POST /_auth/login`. That constraint is why the logo is inline SVG
 * rather than `resources/brand/logo.png` — serving that would mean opening an
 * unauthenticated static route.
 *
 * Visually it mirrors the app's own landing screen (`.weq-home-shell`): same
 * accent (#0099ff), same pale multi-stop gradient, same fine dot grid. The
 * aurora blobs are the one addition — a static gradient reads as "unstyled" on
 * an otherwise empty page.
 */

export const LOGIN_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>WeQ · 登录</title>
<style>
  :root {
    --accent: #0099ff;
    --fg: #142235;
    --fg-muted: #5b7d99;
    --card: rgba(255, 255, 255, 0.72);
    --card-border: rgba(0, 153, 255, 0.16);
    --field: rgba(255, 255, 255, 0.78);
    --field-border: rgba(20, 34, 53, 0.13);
    --danger: #c0392f;
    --shadow: 0 24px 60px -28px rgba(6, 44, 76, 0.34);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e8eef5;
      --fg-muted: #8ba6bd;
      --card: rgba(23, 29, 37, 0.72);
      --card-border: rgba(0, 153, 255, 0.2);
      --field: rgba(13, 17, 23, 0.68);
      --field-border: rgba(255, 255, 255, 0.11);
      --danger: #ff7b70;
      --shadow: 0 24px 60px -28px rgba(0, 0, 0, 0.7);
    }
  }

  * { box-sizing: border-box; }

  html, body { height: 100%; }

  body {
    margin: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    overflow: hidden;
    color: var(--fg);
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    /* Same multi-stop wash as .weq-home-shell in the app. */
    background:
      radial-gradient(ellipse at 14% 16%, rgba(0, 153, 255, 0.11) 0, transparent 42%),
      radial-gradient(ellipse at 78% 14%, rgba(255, 220, 83, 0.10) 0, transparent 38%),
      radial-gradient(ellipse at 82% 82%, rgba(83, 206, 144, 0.09) 0, transparent 42%),
      radial-gradient(ellipse at 36% 88%, rgba(132, 126, 224, 0.055) 0, transparent 46%),
      linear-gradient(135deg, #fdfeff 0%, #f8fcff 38%, #fffef4 68%, #fbfffc 100%);
  }

  @media (prefers-color-scheme: dark) {
    body {
      background:
        radial-gradient(ellipse at 14% 16%, rgba(0, 153, 255, 0.16) 0, transparent 44%),
        radial-gradient(ellipse at 80% 84%, rgba(83, 206, 144, 0.10) 0, transparent 44%),
        linear-gradient(150deg, #10161e 0%, #0d1117 52%, #121a22 100%);
    }
  }

  /* --- aurora: three slow-drifting blurred blobs --- */
  .aurora {
    position: fixed;
    inset: -25vmax;
    z-index: 0;
    pointer-events: none;
    filter: blur(72px);
    opacity: 0.55;
  }
  .aurora i {
    position: absolute;
    display: block;
    border-radius: 50%;
    mix-blend-mode: multiply;
  }
  @media (prefers-color-scheme: dark) {
    .aurora { opacity: 0.42; }
    .aurora i { mix-blend-mode: screen; }
  }
  .aurora i:nth-child(1) {
    width: 44vmax; height: 44vmax; top: 8%; left: 6%;
    background: radial-gradient(circle, rgba(0, 153, 255, 0.5), transparent 68%);
    animation: drift-a 26s ease-in-out infinite;
  }
  .aurora i:nth-child(2) {
    width: 38vmax; height: 38vmax; top: 44%; left: 58%;
    background: radial-gradient(circle, rgba(83, 206, 144, 0.42), transparent 68%);
    animation: drift-b 33s ease-in-out infinite;
  }
  .aurora i:nth-child(3) {
    width: 34vmax; height: 34vmax; top: 2%; left: 52%;
    background: radial-gradient(circle, rgba(132, 126, 224, 0.36), transparent 68%);
    animation: drift-c 29s ease-in-out infinite;
  }

  @keyframes drift-a {
    0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
    50%      { transform: translate3d(9vmax, 6vmax, 0) scale(1.14); }
  }
  @keyframes drift-b {
    0%, 100% { transform: translate3d(0, 0, 0) scale(1.06); }
    50%      { transform: translate3d(-11vmax, -7vmax, 0) scale(0.9); }
  }
  @keyframes drift-c {
    0%, 100% { transform: translate3d(0, 0, 0) scale(0.94); }
    50%      { transform: translate3d(-6vmax, 10vmax, 0) scale(1.12); }
  }

  /* --- the fine dot grid the app's home shell uses --- */
  .grain {
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    opacity: 0.2;
    mix-blend-mode: multiply;
    background-image:
      radial-gradient(circle at 14% 22%, rgba(0, 153, 255, 0.22) 0 0.34px, transparent 0.42px),
      radial-gradient(circle at 73% 31%, rgba(112, 96, 54, 0.18) 0 0.3px, transparent 0.42px),
      radial-gradient(circle at 46% 78%, rgba(31, 104, 79, 0.18) 0 0.32px, transparent 0.44px),
      radial-gradient(circle at 88% 66%, rgba(0, 153, 255, 0.12) 0 0.28px, transparent 0.42px);
    background-size: 13px 17px, 19px 23px, 29px 31px, 37px 41px;
    background-position: 0 0, 7px 11px, 17px 5px, 23px 29px;
  }
  @media (prefers-color-scheme: dark) {
    .grain { mix-blend-mode: screen; opacity: 0.12; }
  }

  /* --- card --- */
  form {
    position: relative;
    z-index: 2;
    width: min(372px, calc(100vw - 40px));
    padding: 38px 32px 30px;
    text-align: center;
    background: var(--card);
    border: 1px solid var(--card-border);
    border-radius: 18px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(20px) saturate(1.35);
    -webkit-backdrop-filter: blur(20px) saturate(1.35);
    animation: rise 720ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(18px) scale(0.975); filter: blur(6px); }
    to   { opacity: 1; transform: none; filter: none; }
  }

  .mark {
    width: 74px; height: 74px;
    margin: 0 auto 16px;
    filter: drop-shadow(0 12px 22px rgba(0, 122, 204, 0.26));
    animation: float 6.5s ease-in-out infinite;
  }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-5px); }
  }

  h1 {
    margin: 0;
    font-size: 27px;
    font-weight: 600;
    letter-spacing: 0.5px;
  }
  p.hint {
    margin: 7px 0 26px;
    font-size: 12.5px;
    letter-spacing: 0.06em;
    color: var(--fg-muted);
  }

  .field { text-align: left; }

  label {
    display: block;
    margin-bottom: 7px;
    font-size: 12px;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
  }

  input {
    width: 100%;
    padding: 11px 13px;
    font-size: 15px;
    font-family: inherit;
    letter-spacing: 0.08em;
    color: var(--fg);
    background: var(--field);
    border: 1px solid var(--field-border);
    border-radius: 10px;
    transition: border-color 160ms ease, box-shadow 220ms ease;
  }
  input::placeholder {
    letter-spacing: normal;
    color: color-mix(in srgb, var(--fg-muted) 62%, transparent);
  }
  input:focus {
    outline: none;
    border-color: var(--accent);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 15%, transparent);
  }

  button {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    width: 100%;
    margin-top: 18px;
    padding: 11px;
    font-size: 14.5px;
    font-weight: 500;
    font-family: inherit;
    letter-spacing: 0.04em;
    color: #fff;
    background: linear-gradient(120deg, #0099ff 0%, #38b6ff 52%, #0099ff 100%);
    background-size: 220% 100%;
    border: 0;
    border-radius: 10px;
    cursor: pointer;
    box-shadow: 0 10px 24px -12px rgba(0, 122, 204, 0.75);
    transition: transform 160ms ease, box-shadow 220ms ease, background-position 520ms ease;
  }
  button:hover:not(:disabled) {
    transform: translateY(-1px);
    background-position: 100% 0;
    box-shadow: 0 14px 30px -12px rgba(0, 122, 204, 0.85);
  }
  button:active:not(:disabled) { transform: translateY(0); }
  button:disabled { cursor: default; opacity: 0.62; box-shadow: none; }

  .spinner {
    width: 15px; height: 15px;
    border: 2px solid rgba(255, 255, 255, 0.34);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 780ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .err {
    min-height: 19px;
    margin-top: 13px;
    font-size: 12.5px;
    color: var(--danger);
  }

  form.shake { animation: shake 400ms cubic-bezier(0.36, 0.07, 0.19, 0.97); }
  @keyframes shake {
    10%, 90% { transform: translateX(-2px); }
    20%, 80% { transform: translateX(4px); }
    30%, 50%, 70% { transform: translateX(-7px); }
    40%, 60% { transform: translateX(7px); }
  }

  .foot {
    margin: 18px 0 0;
    font-size: 11.5px;
    letter-spacing: 0.05em;
    color: color-mix(in srgb, var(--fg-muted) 72%, transparent);
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
    }
  }
</style>
</head>
<body>
<div class="aurora" aria-hidden="true"><i></i><i></i><i></i></div>
<div class="grain" aria-hidden="true"></div>

<form id="f">
  <svg class="mark" viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="g" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
        <stop stop-color="#1f7bff" />
        <stop offset="1" stop-color="#12b5ff" />
      </linearGradient>
    </defs>
    <circle cx="29" cy="29" r="25" fill="url(#g)" />
    <path d="m22 44-5.5 10 11-3.4 1.6-6.6H22Z" fill="url(#g)" />
    <path d="M29 12c-6.9 0-12 5.6-12 13 0 3.3-1.4 5.4-2.6 7.2-1 1.6-1.9 2.9-1.4 4.5.6 1.9 2.9 2.6 5.4 2.9 1.2 2.6 5.4 4.6 10.6 4.6s9.4-2 10.6-4.6c2.5-.3 4.8-1 5.4-2.9.5-1.6-.4-2.9-1.4-4.5-1.2-1.8-2.6-3.9-2.6-7.2 0-7.4-5.1-13-12-13Z" fill="#fff" />
    <rect x="39" y="41" width="21" height="17" rx="4.5" fill="#fff" />
    <path d="M44 41v-4a5.5 5.5 0 0 1 11 0v4" stroke="#fff" stroke-width="3.6" stroke-linecap="round" />
    <circle cx="49.5" cy="48" r="2.5" fill="url(#g)" />
    <rect x="48.3" y="48" width="2.4" height="4.4" rx="1.2" fill="url(#g)" />
  </svg>

  <h1>WeQ</h1>
  <p class="hint">QQ NT 本地数据工具</p>

  <div class="field">
    <label for="t">访问令牌</label>
    <input id="t" type="password" autocomplete="current-password" placeholder="粘贴启动时打印的令牌" autofocus />
  </div>

  <button id="b" type="submit">进入</button>
  <div class="err" id="e" role="alert"></div>
  <p class="foot">数据全程留在本机 · 不上传任何服务器</p>
</form>

<script>
  const f = document.getElementById('f');
  const t = document.getElementById('t');
  const b = document.getElementById('b');
  const e = document.getElementById('e');

  function fail(msg) {
    e.textContent = msg;
    f.classList.remove('shake');
    // Force reflow so the animation restarts on a repeated failure.
    void f.offsetWidth;
    f.classList.add('shake');
  }

  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    e.textContent = '';
    b.disabled = true;
    b.innerHTML = '<span class="spinner"></span><span>验证中…</span>';
    try {
      const res = await fetch('/_auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: t.value }),
      });
      if (res.ok) { location.replace('/'); return; }
      fail(res.status === 429 ? '尝试过于频繁，请稍候再试。' : '令牌不正确。');
    } catch {
      fail('无法连接服务器。');
    }
    b.disabled = false;
    b.textContent = '进入';
    t.select();
  });
</script>
</body>
</html>`;
