// 在业务模块加载前读取已有主题快照；正式主题服务随后校准，不写回设置。
(() => {
  const root = document.documentElement;
  let preference = 'system';
  let accent = '';
  try {
    const server = JSON.parse(localStorage.getItem('weq.sync.v1:server') || '""');
    const snapshot = JSON.parse(localStorage.getItem(`weq.sync.v1:${server}:shared`) || '{}');
    const values = snapshot.values || snapshot;
    preference = values.preference || localStorage.getItem('weq.theme-preference') || 'system';
    accent = values.accent ?? localStorage.getItem('weq.theme-accent') ?? '';
  } catch {
    // 缓存不可读时跟随系统；不阻断首屏。
  }
  const dark =
    preference === 'dark' ||
    (preference !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'dark' : 'light';
  root.style.colorScheme = dark ? 'dark' : 'light';
  if (typeof accent === 'string' && /^#[\da-f]{6}$/i.test(accent))
    root.style.setProperty('--weq-accent-custom', accent);
})();
