/**
 * Built-in QQ 频道 (pd.qq.com) browser.
 *
 * Opens a dedicated BrowserWindow that loads https://pd.qq.com/ in a
 * **persistent, per-account** session partition. Electron persists that
 * partition's cookie jar to disk automatically, so:
 *   - login state survives app restarts ("本地保存 Cookie，有 cookie 自动注入"),
 *   - each account gets its own jar keyed by the same (uin, dataDir) id the rest
 *     of the app uses ("按账号隔离") — switching accounts switches the partition.
 *
 * Auto-login: when 设置 → 自动获取 ClientKey is on AND a logged-in QQ.exe for the
 * account is running (already hook-injected by the account monitor), we swap its
 * credential for a `pd.qq.com` p_skey via the native helper and seed the jar with
 * `uin` / `p_uin` / `p_skey` — enough for pd.qq.com to treat the page as logged
 * in. If the setting is off or no online instance exists, we fall back to
 * whatever cookies the persistent partition already holds.
 *
 * The window hosts untrusted remote content, so it gets NO preload and runs
 * sandboxed/context-isolated — the privileged tRPC bridge never reaches it.
 *
 * The harvested cookies live on in the persistent partition, ready for future
 * 频道相关的导出/分析 work (see `channel:get-cookies`).
 */

import { BrowserWindow, ipcMain, session, shell } from 'electron';
import { accountConfigId, getLogger, logErrorContext } from '@weq/service';
import { getAppContext } from './context/app_context';

const CHANNEL_URL = 'https://pd.qq.com/';
/** Domain the channel p_skey is minted for (native `fetchPskey` argument). */
const CHANNEL_PSKEY_DOMAIN = 'pd.qq.com';

const logger = getLogger().child({ scope: 'qq-channel' });

/** Live channel windows, keyed by session partition (one per account). */
const channelWindows = new Map<string, BrowserWindow>();

/**
 * Persistent session partition for the currently-open account. Cookies live on
 * disk under this partition; the `persist:` prefix is what makes Electron keep
 * them across restarts. Keyed by `accountConfigId(uin, dataDir)` so two accounts
 * — even the same UIN from different data dirs — never share a cookie jar.
 */
function resolvePartition(): string {
  const ctx = getAppContext();
  const uin = ctx.account?.context.uin;
  if (!uin) return 'persist:qqchannel-anon';
  const dataDir = ctx.services?.accountConfig.getRecord()?.dataDir;
  return `persist:qqchannel-${accountConfigId(String(uin), dataDir)}`;
}

/**
 * Best-effort auto-login: seed `uin` / `p_uin` / `p_skey` into the channel jar
 * from the live QQ instance. No-op (returns silently) unless 自动获取 ClientKey is
 * on and a logged-in QQ.exe is online — the monitor injects the hook on
 * account-online, so `fetchPskey` works off the recorded pid. On any failure we
 * leave the jar untouched and let the persistent cookies (if any) carry login.
 */
async function injectAutoLoginCookies(partition: string): Promise<void> {
  const ctx = getAppContext();
  const autoFetch = ctx.bootstrap?.userConfig.getSettings().autoFetchClientKey ?? false;
  if (!autoFetch) return;

  const uin = ctx.account?.context.uin;
  const nt = ctx.platform?.native.ntHelper;
  const record = ctx.services?.accountConfig.getRecord();
  if (!uin || !nt || !record?.qqOnline || !record.qqPid) return;

  const pskey = await nt.fetchPskey(record.qqPid, String(uin), CHANNEL_PSKEY_DOMAIN);
  if (!pskey) return;

  const ses = session.fromPartition(partition);
  const pUin = `o${uin}`;
  // Domain-scoped to .qq.com so the cookies ride along to every pd.qq.com page;
  // url must match the domain for Electron to accept a domain cookie.
  const base = { url: 'https://pd.qq.com', domain: '.qq.com', path: '/' } as const;
  await Promise.all([
    ses.cookies.set({ ...base, name: 'uin', value: pUin }),
    ses.cookies.set({ ...base, name: 'p_uin', value: pUin }),
    ses.cookies.set({ ...base, name: 'p_skey', value: pskey }),
  ]);
  logger.info('seeded qq channel login cookies', { event: 'channel-autologin', uin: String(uin) });
}

async function openChannelWindow(): Promise<void> {
  const partition = resolvePartition();
  const existing = channelWindows.get(partition);
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
    title: 'QQ 频道',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      // Per-account, on-disk cookie jar — the whole point of the feature.
      partition,
      sandbox: true,
      contextIsolation: true,
      // No preload: this hosts remote content (pd.qq.com); keep the app's
      // privileged bridge out of its reach.
    },
  });
  channelWindows.set(partition, win);
  win.on('closed', () => {
    if (channelWindows.get(partition) === win) channelWindows.delete(partition);
  });

  // QQ 登录 (扫码 / 快捷登录) flows open child popups — allow them so the popup
  // shares this partition and its cookies land in the same per-account jar.
  win.webContents.setWindowOpenHandler(() => ({ action: 'allow' }));

  // Seed login cookies before the first navigation so the very first request to
  // pd.qq.com already carries them. Failures are non-fatal — fall back to the
  // persistent jar.
  await injectAutoLoginCookies(partition).catch((error) => {
    logger.warn('channel auto-login cookie injection failed', {
      event: 'channel-autologin-failed',
      ...logErrorContext(error),
    });
  });

  logger.info('opening qq channel browser', { event: 'channel-open', partition });
  void win.loadURL(CHANNEL_URL);
}

export function registerChannelIpc(): void {
  ipcMain.handle('channel:open', async () => {
    await openChannelWindow();
    return true;
  });

  // Future 频道导出/分析: read the current account's pd.qq.com cookies straight
  // from its persistent partition (no window needs to be open).
  ipcMain.handle('channel:get-cookies', async () => {
    const partition = resolvePartition();
    const cookies = await session.fromPartition(partition).cookies.get({ domain: 'qq.com' });
    return cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
  });
}
