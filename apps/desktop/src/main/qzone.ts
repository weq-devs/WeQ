/**
 * Built-in QQ 空间 (qzone.qq.com) browser.
 *
 * Mirrors the QQ 频道 browser (see `channel.ts`): a dedicated BrowserWindow
 * loading the current account's Qzone homepage in a **persistent, per-account**
 * session partition, so login state survives restarts and每个账号各用各的 cookie
 * jar (keyed by the same (uin, dataDir) id the rest of the app uses).
 *
 * Auto-login: when 设置 → 自动获取 ClientKey is on AND a logged-in QQ.exe for the
 * account is running, we swap its credential for Qzone's web tokens via the
 * native helper and seed the jar with `uin` / `p_uin` / `skey` / `p_skey` — Qzone
 * needs the plain `skey` (for its g_tk csrf) on top of the `p_skey` that 频道 uses,
 * so we fetch both for the `qzone.qq.com` domain. If the setting is off or no
 * online instance exists, we fall back to whatever cookies the persistent
 * partition already holds.
 *
 * The window hosts untrusted remote content, so it gets NO preload and runs
 * sandboxed/context-isolated — the privileged tRPC bridge never reaches it.
 */

import { BrowserWindow, ipcMain, nativeTheme, session } from 'electron';
import { accountConfigId, getLogger, logErrorContext } from '@weq/service';
import { getAppContext } from './context/app_context';

/** Domain the Qzone skey / p_skey are minted for (native fetch arguments). */
const QZONE_PSKEY_DOMAIN = 'qzone.qq.com';

/**
 * Qzone homepage for `uin`. `loginfrom=31` matches the desktop entry the user
 * asked for; without a uin (not logged in) fall back to the generic landing page
 * which redirects through login.
 */
function qzoneUrl(uin: string | number | undefined): string {
  return uin
    ? `https://user.qzone.qq.com/${uin}/infocenter?loginfrom=31`
    : 'https://qzone.qq.com/';
}

/** WeQ's theme preference, mirrored 1:1 onto `nativeTheme.themeSource`. */
type QzoneTheme = 'system' | 'light' | 'dark';

/**
 * Follow WeQ's 深/浅 mode. `nativeTheme.themeSource` is the only lever Electron
 * gives for a window's `prefers-color-scheme`, and it's process-global — so the
 * Qzone window's remote content and native chrome track WeQ (same as 频道).
 */
function applyQzoneTheme(theme: QzoneTheme | undefined): void {
  if (theme === 'system' || theme === 'light' || theme === 'dark') {
    nativeTheme.themeSource = theme;
  }
}

const logger = getLogger().child({ scope: 'qq-zone' });

/** Live Qzone windows, keyed by session partition (one per account). */
const qzoneWindows = new Map<string, BrowserWindow>();

/**
 * Persistent session partition for the currently-open account. Cookies live on
 * disk under this partition; the `persist:` prefix is what makes Electron keep
 * them across restarts. Keyed by `accountConfigId(uin, dataDir)` so two accounts
 * — even the same UIN from different data dirs — never share a cookie jar.
 */
function resolvePartition(): string {
  const ctx = getAppContext();
  const uin = ctx.account?.context.uin;
  if (!uin) return 'persist:qqzone-anon';
  const dataDir = ctx.services?.accountConfig.getRecord()?.dataDir;
  return `persist:qqzone-${accountConfigId(String(uin), dataDir)}`;
}

/**
 * Best-effort auto-login: seed `uin` / `p_uin` / `skey` / `p_skey` into the Qzone
 * jar from the live QQ instance. No-op (returns silently) unless 自动获取
 * ClientKey is on and a logged-in QQ.exe is online. On any failure we leave the
 * jar untouched and let the persistent cookies (if any) carry login.
 */
async function injectAutoLoginCookies(partition: string): Promise<void> {
  const ctx = getAppContext();
  const autoFetch = ctx.bootstrap?.userConfig.getSettings().autoFetchClientKey ?? false;
  if (!autoFetch) return;

  const uin = ctx.account?.context.uin;
  const nt = ctx.platform?.native.ntHelper;
  const record = ctx.services?.accountConfig.getRecord();
  if (!uin || !nt || !record?.qqOnline || !record.qqPid) return;

  // Sequential, not parallel: both fetchers drive OIDB over the same hook pipe
  // for this pid, so overlapping them risks contention (see web/credential.ts).
  const skey = await nt.fetchSkey(record.qqPid, String(uin));
  const pskey = await nt.fetchPskey(record.qqPid, String(uin), QZONE_PSKEY_DOMAIN);
  if (!skey && !pskey) return;

  const ses = session.fromPartition(partition);
  const pUin = `o${uin}`;
  // Domain-scoped to .qq.com so the cookies ride along to every qzone.qq.com
  // page; url must match the domain for Electron to accept a domain cookie.
  const base = { url: 'https://qzone.qq.com', domain: '.qq.com', path: '/' } as const;
  const jar: Array<{ name: string; value: string }> = [
    { name: 'uin', value: pUin },
    { name: 'p_uin', value: pUin },
    { name: 'skey', value: skey },
    { name: 'p_skey', value: pskey },
  ];
  await Promise.all(
    jar.filter((c) => c.value).map((c) => ses.cookies.set({ ...base, name: c.name, value: c.value })),
  );
  logger.info('seeded qq zone login cookies', { event: 'qzone-autologin', uin: String(uin) });
}

async function openQzoneWindow(): Promise<void> {
  const partition = resolvePartition();
  const existing = qzoneWindows.get(partition);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: 'QQ 空间',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      // Per-account, on-disk cookie jar — the whole point of the feature.
      partition,
      sandbox: true,
      contextIsolation: true,
      // No preload: this hosts remote content (qzone.qq.com); keep the app's
      // privileged bridge out of its reach.
    },
  });
  qzoneWindows.set(partition, win);
  win.on('closed', () => {
    if (qzoneWindows.get(partition) === win) qzoneWindows.delete(partition);
  });

  // QQ 登录 (扫码 / 快捷登录) flows open child popups — allow them so the popup
  // shares this partition and its cookies land in the same per-account jar.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

  // Seed login cookies before the first navigation so the very first request to
  // qzone.qq.com already carries them. Failures are non-fatal — fall back to the
  // persistent jar.
  await injectAutoLoginCookies(partition).catch((error) => {
    logger.warn('qzone auto-login cookie injection failed', {
      event: 'qzone-autologin-failed',
      ...logErrorContext(error),
    });
  });

  const url = qzoneUrl(getAppContext().account?.context.uin);
  logger.info('opening qq zone browser', { event: 'qzone-open', partition });
  void win.loadURL(url);
}

export function registerQzoneIpc(): void {
  ipcMain.handle('qzone:open', async (_event, theme?: QzoneTheme) => {
    applyQzoneTheme(theme);
    await openQzoneWindow();
    return true;
  });

  // 内嵌模式（QzoneView 的 <webview>）入口：应用主题、解析 per-account 分区、
  // 在首次导航前把自动登录 cookie 种进该分区，然后把 partition/url 交给渲染层，
  // 由 <webview> 用同一个 partition 加载。cookie 注入失败不致命 —— 回退到持久
  // 分区里已有的 cookie。返回的 partition 与独立窗口用的是同一套，登录状态互通。
  ipcMain.handle('qzone:prepare', async (_event, theme?: QzoneTheme) => {
    applyQzoneTheme(theme);
    const partition = resolvePartition();
    await injectAutoLoginCookies(partition).catch((error) => {
      logger.warn('qzone auto-login cookie injection failed', {
        event: 'qzone-autologin-failed',
        ...logErrorContext(error),
      });
    });
    const url = qzoneUrl(getAppContext().account?.context.uin);
    logger.info('preparing embedded qq zone webview', { event: 'qzone-prepare', partition });
    return { partition, url };
  });

  // Live theme follow: the renderer pushes this whenever WeQ's 深/浅 mode changes
  // so an already-open Qzone window updates without being reopened.
  ipcMain.handle('qzone:set-theme', (_event, theme?: QzoneTheme) => {
    applyQzoneTheme(theme);
    return true;
  });

  // Future 空间导出/分析: read the current account's qzone.qq.com cookies straight
  // from its persistent partition (no window needs to be open).
  ipcMain.handle('qzone:get-cookies', async () => {
    const partition = resolvePartition();
    const cookies = await session.fromPartition(partition).cookies.get({ domain: 'qq.com' });
    return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
  });
}
