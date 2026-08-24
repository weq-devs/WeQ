/**
 * Bootstrap router — services usable before any account is selected.
 *
 *   - native-init status (so the renderer can show an error dialog)
 *   - install / process / account detection (cached in global config)
 *   - dbkey acquisition (3 flows) + key correctness probe
 *   - chart stats (db file sizes / nt_data subdir sizes)
 *   - auto-enter target read/write
 *   - manual key entry handoff (validate + open account)
 *
 * The QR / quick login flows are exposed as tRPC subscriptions, with the
 * underlying `AsyncIterable<KeyEvent>` converted to an `observable`.
 * superjson moves `bigint`s through unscathed.
 */

import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { isMcpRunning } from '../../mcp/server';
import { isWeqServerRunning } from '../../weq_assistant/server';
import {
  accountEventBus,
  getAppContext,
  requireBootstrap,
  requirePlatform,
  emitDressChanged,
  rememberAccountUid,
  type AccountForcedClosedEvent,
} from '../../context/app_context';
import { procedure, router } from '../trpc';
import {
  accountConfigId,
  fetchHomeDress,
  getHost,
  getLogger,
  logErrorContext,
  type KeyEvent,
  type VoiceDownloadProgress,
  type TtsProviderConfig,
  type DirSizeProgress,
  validateChatpicRoot,
  normalizeNapcatBaseUrl,
} from '@weq/service';
import { peekStaticSelfUin, deriveAndroidDbKey } from '@weq/account';
import { isTencentFilesRoot } from '@weq/platform';

/** Result of the Tencent Files folder picker (with the hard `Tencent Files` rule). */
export interface PickRootResult {
  /** True only when a valid `Tencent Files` folder was picked and persisted. */
  ok: boolean;
  /** The path the user picked (kept on rejection so the UI can show it), or null on cancel. */
  path: string | null;
  /** Human-readable reason when `ok` is false and the user didn't just cancel. */
  error?: string;
}

const algoSchema = z.object({
  pageHmacAlgorithm: z.string(),
  kdfHmacAlgorithm: z.string(),
});

const logger = getLogger().child({ scope: 'bootstrap-router' });

/** 从服务器地址里提取主机名，用作默认展示名。 */
function hostOfServerUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Ensure the uin→uid mapping is registered so linux path resolution
 * (`platform.ntMsgDbPath(uin)` etc., which hashes uid into the account dir)
 * works during the login flow — before the account is saved to config. Reads
 * the decrypted login.db account list and seeds the in-memory registry. No-op
 * on win32 (paths key off uin there) and when the uid is already known.
 */
export async function ensureUidForUin(
  boot: ReturnType<typeof requireBootstrap>,
  uin: string,
): Promise<void> {
  try {
    const accounts = await boot.detect.listAccounts();
    const match = accounts.find((a) => a.uin === uin && a.uid);
    if (match?.uid) rememberAccountUid(uin, match.uid);
  } catch (e) {
    logger.warn('ensureUidForUin failed to resolve uid', {
      event: 'ensure-uid-failed',
      uin,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

export const bootstrapRouter = router({
  // ---- native health ----

  /** Classified native-init error, or null when the bundle loaded fine. */
  nativeStatus: procedure.query(() => {
    return getAppContext().nativeError;
  }),

  /** Background account session was forcibly closed by main process. */
  onAccountForcedClosed: procedure.subscription(() => {
    return observable<AccountForcedClosedEvent>((emit) => {
      const handler = (event: AccountForcedClosedEvent): void => {
        emit.next(event);
      };
      accountEventBus.on('forcedClosed', handler);
      return () => {
        accountEventBus.off('forcedClosed', handler);
      };
    });
  }),

  /** Platform kind, so the renderer can branch linux-only key behaviour. */
  systemInfo: procedure.query(() => {
    return { platformKind: process.platform as NodeJS.Platform };
  }),

  // ---- detection (via global config cache) ----

  /** Enriched, cached install info (paths + version + user-data + health flags). */
  describeInstall: procedure.query(() => {
    return requireBootstrap().globalConfig.describeInstall();
  }),

  /** Force a fresh install probe (e.g. after the user changes the data dir). */
  refreshInstall: procedure.mutation(() => {
    return requireBootstrap().globalConfig.refresh();
  }),

  listAccounts: procedure.query(() => {
    return requireBootstrap().detect.listAccounts();
  }),

  /**
   * Resolve the running QQ pid hosting this account (db-lock probe, QQ-name
   * filtered by the platform) — or null when no QQ instance for this account
   * is around.
   */
  resolveQqPid: procedure.input(z.object({ uin: z.string().min(1) })).query(async ({ input }) => {
    const boot = requireBootstrap();
    // Linux resolves the account dir from uid; seed it before probing so a
    // fresh account (uid not yet saved to config) still resolves.
    await ensureUidForUin(boot, input.uin);
    return requirePlatform().resolveQqPid(input.uin);
  }),

  /** Online-instance probe (with the single-process uin-iteration refinement). */
  probeOnline: procedure
    .input(z.object({ knownUins: z.array(z.string()).default([]) }).optional())
    .query(({ input }) => {
      return requireBootstrap().globalConfig.probeOnline(input?.knownUins ?? []);
    }),

  /** Count of user-data directories under the Tencent Files root. */
  countUserDataDirs: procedure.query(() => {
    return requireBootstrap().globalConfig.countUserDataDirs();
  }),

  // ---- chart stats ----

  /** Largest database files for an account (language-bar chart). */
  dbFileSizes: procedure
    .input(z.object({ uin: z.string(), topN: z.number().int().positive().max(20).optional() }))
    .query(async ({ input }) => {
      const boot = requireBootstrap();
      // Linux resolves the account dir from uid; seed it before scanning so
      // the pre-open stats screen works (the account isn't open yet).
      await ensureUidForUin(boot, input.uin);
      return boot.globalConfig.dbFileSizes(input.uin, input.topN ?? 8);
    }),

  /** nt_data subdirectory sizes for an account (space chart; may be slow). */
  ntDataSizes: procedure.input(z.object({ uin: z.string() })).query(async ({ input }) => {
    const boot = requireBootstrap();
    await ensureUidForUin(boot, input.uin);
    return boot.globalConfig.ntDataSubdirSizes(input.uin);
  }),

  /**
   * Live total size of the account's user-data directory: emits
   * `{ bytes, done }` every ~100 ms while scanning (huge trees take a while),
   * with a terminal `done: true` event. The UI animates the growing number
   * instead of sitting on a static spinner.
   */
  accountDirSizeProgress: procedure
    .input(z.object({ uin: z.string() }))
    .subscription(({ input }) => {
      return observable<DirSizeProgress>((emit) => {
        const boot = requireBootstrap();
        void ensureUidForUin(boot, input.uin);
        const iterator = boot.globalConfig.accountDirSizeStream(input.uin)[Symbol.asyncIterator]();
        let cancelled = false;
        void (async (): Promise<void> => {
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done || cancelled) break;
              emit.next(next.value);
            }
            emit.complete();
          } catch (e) {
            emit.error(e);
          }
        })();
        return () => {
          cancelled = true;
          void iterator.return?.(undefined);
        };
      });
    }),

  // ---- user config ----

  readConfig: procedure.query(() => {
    return requireBootstrap().userConfig.read();
  }),

  listAccountConfigs: procedure.query(() => {
    return requireBootstrap().userConfig.listAccountConfigs();
  }),

  deleteAccountConfig: procedure.input(z.object({ configId: z.string() })).mutation(({ input }) => {
    requireBootstrap().userConfig.deleteAccountConfig(input.configId);
    return true;
  }),

  // ---- auto-enter target ----

  getAutoEnter: procedure.query(() => {
    return requireBootstrap().userConfig.getAutoEnter();
  }),

  setAutoEnter: procedure
    .input(z.object({ uin: z.string(), dataDir: z.string().optional() }))
    .mutation(({ input }) => {
      const boot = requireBootstrap();
      const dataDir = input.dataDir ?? boot.globalConfig.accountDataDir(input.uin) ?? undefined;
      const configId = accountConfigId(input.uin, dataDir);
      boot.userConfig.setAutoEnter({ configId, uin: input.uin, ...(dataDir ? { dataDir } : {}) });
      logger.info('set auto-enter target from bootstrap router', {
        event: 'router-set-auto-enter',
        accountUin: input.uin,
        dataDir: dataDir ?? null,
        configId,
      });
      return true;
    }),

  clearAutoEnter: procedure.mutation(() => {
    requireBootstrap().userConfig.clearAutoEnter();
    return true;
  }),

  // ---- version (设置 → 全局设置) ----

  /** WeQ app version + the runtime versions, for the 全局设置 page. */
  getVersionInfo: procedure.query(() => {
    const host = getHost();
    return {
      app: host.appVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      isDev: !host.isPackaged(),
    };
  }),

  // ---- app settings (设置 → 账号基础 / 全局设置) ----

  /** Full, defaulted global settings (realtime / 自动注入 QQ / …). */
  getSettings: procedure.query(() => {
    return requireBootstrap().userConfig.getSettings();
  }),

  /**
   * Toggle 启用数据库监听. Persists, then applies live to the open account so the
   * nt_msg.db watcher mounts/unmounts immediately (no re-open needed).
   */
  setRealtimeEnabled: procedure.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    requireBootstrap().userConfig.setSettings({ realtimeEnabled: input.enabled });
    getAppContext().applyRealtime(input.enabled);
    return true;
  }),

  /**
   * Toggle 自动注入 QQ（完整功能总闸）. Persists, and the account monitor reads
   * it live on its next poll so injection / harvesting starts or stops
   * immediately (no re-open needed). 关闭 = 完全离线模式。
   */
  setAutoInjectQq: procedure.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    requireBootstrap().userConfig.setSettings({ autoInjectQq: input.enabled });
    return true;
  }),

  /**
   * 空闲自动上锁阈值（分钟）。0 = 关闭自动上锁。渲染层的 AppLockOverlay
   * 读取该值驱动空闲计时；手动上锁与之无关，始终可用。
   */
  setAutoLockMinutes: procedure
    .input(z.object({ minutes: z.number().int().min(0).max(120) }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ autoLockMinutes: input.minutes });
      return true;
    }),

  /** 应用锁总开关（设置 → 应用锁）。关闭后手动 / 自动上锁都不生效。 */
  setAppLockEnabled: procedure.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    requireBootstrap().userConfig.setSettings({ appLock: { enabled: input.enabled } });
    return true;
  }),

  /**
   * 应用锁解锁方式（设置 → 应用锁）：'totp' = WeQ 验证器（默认），
   * 'system' = Windows Hello / Touch ID。
   */
  setAppLockMethod: procedure
    .input(z.object({ method: z.enum(['totp', 'system']) }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ appLock: { method: input.method } });
      return true;
    }),

  /**
   * 关闭按钮行为（最小化到托盘 / 直接退出 / 每次询问）。主进程的 window
   * 'close' 拦截会在下一次关闭时读取该值——纯持久化，无需即时应用。
   */
  setWindowCloseBehavior: procedure
    .input(z.object({ behavior: z.enum(['ask', 'tray', 'quit']) }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ windowCloseBehavior: input.behavior });
      return true;
    }),

  /**
   * 是否把纯文本消息里的 Markdown 也渲染。渲染层通过 App.tsx 的 TextMarkdownContext
   * 读取（getSettings 查询失效后自动生效）——纯持久化，无需主进程侧应用。
   */
  setRenderTextMarkdown: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ renderTextMarkdown: input.enabled });
      return true;
    }),

  /**
   * 头像挂件是否叠在聊天页自己的头像上。渲染层通过 App.tsx 的 SelfPendantContext
   * 读取——纯持久化，无需主进程侧应用。
   */
  setShowAvatarPendant: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ showAvatarPendant: input.enabled });
      return true;
    }),

  /** 数据库损坏弹窗「不再提醒」开关（全局配置，重启后仍生效）。 */
  setSuppressDbDamageReminder: procedure
    .input(z.object({ suppressed: z.boolean() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ suppressDbDamageReminder: input.suppressed });
      return true;
    }),

  /**
   * 头像与图片/视频封面是否由渲染层直连 QQ CDN（省服务端带宽，代价是绕开本地缓存）。
   * 渲染层通过 App.tsx 的 PreferCdnContext 读取——纯持久化，无需主进程侧应用。
   */
  setPreferCdn: procedure.input(z.object({ enabled: z.boolean() })).mutation(({ input }) => {
    requireBootstrap().userConfig.setSettings({ preferCdn: input.enabled });
    return true;
  }),

  /**
   * 聊天里裸链接的展示方式。`enabled` 关掉后只做蓝色下划线、不出网；`screenshot`
   * 决定页面没有 og:image 时要不要用离屏窗口截一张。纯持久化。
   */
  setLinkPreview: procedure
    .input(z.object({ enabled: z.boolean().optional(), screenshot: z.boolean().optional() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ linkPreview: input });
      return true;
    }),

  /** 是否渲染每条消息里的装扮（气泡/字体/挂件）。纯持久化。 */
  setShowMsgDecoration: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }) => {
      requireBootstrap().userConfig.setSettings({ showMsgDecoration: input.enabled });
      return true;
    }),

  /** 导入/清除外部安卓 chatpic 目录（聊天图片兜底）。`dir` 非空时必须是完整的
   *  chatpic 备份（含 chatraw / chatimg / chatthumb 三个子目录），否则抛错。 */
  setExternalChatpic: procedure
    .input(z.object({ dir: z.string(), enabled: z.boolean() }))
    .mutation(({ input }) => {
      if (input.dir) {
        const check = validateChatpicRoot(input.dir);
        if (!check.ok) throw new Error(check.error);
      }
      requireBootstrap().userConfig.setSettings({
        externalChatpic: { dir: input.dir, enabled: input.enabled },
      });
      return true;
    }),

  /** 弹窗选目录 → 校验三个子目录 → 持久化并自动启用。返回结果供界面提示。 */
  pickExternalChatpicDir: procedure.mutation(async () => {
    const picked = await getHost().pickDirectory({
      title: '选择安卓 chatpic 目录（…/Tencent/MobileQQ/chatpic）',
    });
    if (!picked) return { dir: '', enabled: false, error: '' };
    const check = validateChatpicRoot(picked);
    if (!check.ok) return { dir: '', enabled: false, error: check.error };
    requireBootstrap().userConfig.setSettings({
      externalChatpic: { dir: picked, enabled: true },
    });
    return { dir: picked, enabled: true, error: '' };
  }),

  // ---- 外部 rkey 服务器（NapCat）----
  // 全局配置：rkey 与账号权限关系不大，一份配置所有账号通用。媒体下载在本地
  // rkey（需在线 QQ）不可用时会回退到这里，见 service 侧 external_rkey.ts。

  /** 保存（新增或更新）一条外部 rkey 服务器配置。地址自动剥掉 /get_rkey_server 后缀。 */
  saveExternalRkeyServer: procedure
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string(),
        baseUrl: z.string(),
        accessToken: z.string(),
      }),
    )
    .mutation(({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      const baseUrl = normalizeNapcatBaseUrl(input.baseUrl);
      if (!baseUrl) throw new Error('服务器地址无效');
      const token = input.accessToken.trim();
      if (!token) throw new Error('access_token 不能为空');
      const cfg = userConfig.getSettings().externalRkey;
      const existing = input.id ? cfg.servers.find((s) => s.id === input.id) : undefined;
      const id = existing ? existing.id : randomBytes(16).toString('hex');
      const name = input.name.trim() || hostOfServerUrl(baseUrl);
      const entry = { id, name, baseUrl, accessToken: token };
      const servers = existing
        ? cfg.servers.map((s) => {
            if (s.id !== id) return s;
            // 改了地址或 token，缓存的 rkey 可能来自旧服务器，作废重拉。
            if (s.baseUrl !== baseUrl || s.accessToken !== token) {
              const { privateRkey, groupRkey, expiredTime, fetchedAt, ...rest } = s;
              void privateRkey;
              void groupRkey;
              void expiredTime;
              void fetchedAt;
              return { ...rest, ...entry };
            }
            return { ...s, ...entry };
          })
        : [...cfg.servers, entry];
      // 编辑保留原启用状态；新增不自动启用，由用户决定是否开启。
      const enabledServerId = cfg.enabledServerId;
      userConfig.setSettings({ externalRkey: { servers, enabledServerId } });
      return userConfig.getSettings().externalRkey;
    }),

  /** 删除一条配置；删除的是当前启用项时自动回到「不启用」。 */
  deleteExternalRkeyServer: procedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    const userConfig = requireBootstrap().userConfig;
    const cfg = userConfig.getSettings().externalRkey;
    const servers = cfg.servers.filter((s) => s.id !== input.id);
    const enabledServerId = cfg.enabledServerId === input.id ? null : cfg.enabledServerId;
    userConfig.setSettings({ externalRkey: { servers, enabledServerId } });
    return userConfig.getSettings().externalRkey;
  }),

  /** 启用/停用某条配置：同时只能启用一条，传 null 表示全部停用。 */
  setExternalRkeyEnabled: procedure
    .input(z.object({ serverId: z.string().nullable() }))
    .mutation(({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      const cfg = userConfig.getSettings().externalRkey;
      const enabledServerId =
        input.serverId && cfg.servers.some((s) => s.id === input.serverId) ? input.serverId : null;
      userConfig.setSettings({ externalRkey: { enabledServerId } });
      return userConfig.getSettings().externalRkey;
    }),

  /** 测试与外部服务器的连通性（只探测，不写缓存、不影响启用状态）。 */
  testExternalRkeyServer: procedure
    .input(z.object({ baseUrl: z.string(), accessToken: z.string() }))
    .mutation(async ({ input }) => {
      const result = await requireBootstrap().externalRkey.test(input.baseUrl, input.accessToken);
      return { ok: true, name: result.name, expiredTime: result.expiredTime };
    }),

  /**
   * 取一条链接的预览卡片（标题/描述/站点/封面）。抓取全程带 SSRF 闸门 —— 只放行
   * 公网 http(s) 的 80/443，重定向逐跳复检，正文只收 text/html（对方给二进制时
   * body 根本不读）。结果按 URL 落盘缓存，命中不出网。不可预览返回 null。
   */
  linkPreview: procedure
    .input(z.object({ url: z.string().trim().max(2048) }))
    .query(async ({ input }) => {
      const boot = requireBootstrap();
      if (!boot.userConfig.getSettings().linkPreview.enabled) return null;
      return boot.linkPreview.get(input.url);
    }),

  /**
   * 只落一张封面图（不抓页面），返回 `weq-media://linkpreview?id=` 用的缓存 id。
   * 给「QQ 自己已经把标题/封面存在消息里」的那条路用 —— 元数据本地就有，缺的只是
   * 图的字节。走的是抓取路径同一个闸门（公网 http(s) 80/443、魔数校验、大小上限），
   * 因为这个 URL 一样来自不可信的聊天消息。拿不到返回空串。
   */
  linkCover: procedure
    .input(z.object({ url: z.string().trim().max(2048) }))
    .query(async ({ input }) => {
      const boot = requireBootstrap();
      if (!boot.userConfig.getSettings().linkPreview.enabled) return '';
      return boot.linkPreview.cacheCover(input.url);
    }),

  // ---- MCP server (account-bound) ----

  /**
   * Current MCP server config + live state. `token` is returned in full (like
   * the db key in 账号基础); the renderer masks it for display. `running` is
   * true only while an account is open AND the server is listening.
   */
  getMcpStatus: procedure.query(() => {
    const mcp = requireBootstrap().userConfig.getSettings().mcp;
    return {
      enabled: mcp.enabled,
      port: mcp.port,
      token: mcp.token,
      host: '127.0.0.1',
      url: `http://127.0.0.1:${mcp.port}`,
      running: isMcpRunning(),
    };
  }),

  /**
   * Toggle the MCP server. On first enable a bearer token is generated. Persists,
   * then applies live to the open account (starts/stops the HTTP server without
   * re-opening). Throws (e.g. port already in use) so the renderer can report it.
   */
  setMcpEnabled: procedure.input(z.object({ enabled: z.boolean() })).mutation(async ({ input }) => {
    const userConfig = requireBootstrap().userConfig;
    const current = userConfig.getSettings().mcp;
    const token = input.enabled && !current.token ? randomBytes(32).toString('hex') : current.token;
    userConfig.setSettings({ mcp: { enabled: input.enabled, token } });
    await getAppContext().applyMcp(userConfig.getSettings().mcp);
    return userConfig.getSettings().mcp;
  }),

  /** Change the listen port. Persists and restarts the server if it's running. */
  setMcpPort: procedure
    .input(z.object({ port: z.number().int().min(1).max(65535) }))
    .mutation(async ({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      userConfig.setSettings({ mcp: { port: input.port } });
      await getAppContext().applyMcp(userConfig.getSettings().mcp);
      return userConfig.getSettings().mcp;
    }),

  /** Generate a fresh bearer token. Persists and restarts the server if running. */
  regenerateMcpToken: procedure.mutation(async () => {
    const userConfig = requireBootstrap().userConfig;
    userConfig.setSettings({ mcp: { token: randomBytes(32).toString('hex') } });
    await getAppContext().applyMcp(userConfig.getSettings().mcp);
    return userConfig.getSettings().mcp;
  }),

  /** A ready-to-paste client config snippet (Claude Desktop + mcp-remote fallback). */
  getMcpClientConfig: procedure.query(() => {
    const mcp = requireBootstrap().userConfig.getSettings().mcp;
    const url = `http://127.0.0.1:${mcp.port}`;
    return JSON.stringify(
      {
        mcpServers: {
          weq: {
            // 原生支持 Streamable HTTP 的客户端直接用 url + headers：
            url,
            headers: { Authorization: `Bearer ${mcp.token}` },
            // 仅支持 stdio 的客户端（如部分旧版 Claude Desktop）改用下面这行：
            // "command": "npx",
            // "args": ["mcp-remote", "<url>", "--header", "Authorization: Bearer <token>"]
          },
        },
      },
      null,
      2,
    );
  }),

  // ---- WeQ 助手 (account-bound; renders inside QQ itself) ----

  /** Current WeQ 助手 config + live state. */
  getWeqAssistantStatus: procedure.query(() => {
    const weq = requireBootstrap().userConfig.getSettings().weqAssistant;
    return {
      enabled: weq.enabled,
      port: weq.port,
      host: '127.0.0.1',
      url: `http://127.0.0.1:${weq.port}`,
      running: isWeqServerRunning(),
    };
  }),

  /**
   * Toggle WeQ 助手. On enable (with an account open) it fabricates the built-in
   * conversation in the live QQ db + starts the loopback server; on disable it
   * stops the server (the conversation data is left in place). Persists first,
   * then applies live. Throws so the renderer can report failures.
   */
  setWeqAssistantEnabled: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      userConfig.setSettings({ weqAssistant: { enabled: input.enabled } });
      await getAppContext().applyWeqAssistant(userConfig.getSettings().weqAssistant);
      return userConfig.getSettings().weqAssistant;
    }),

  /**
   * Change the listen port (20000–65535). Persists, then re-applies: restarts
   * the server and rewrites the ARK card's embedded coverUrl / jump url so the
   * message in QQ points at the new port.
   */
  setWeqAssistantPort: procedure
    .input(z.object({ port: z.number().int().min(20000).max(65535) }))
    .mutation(async ({ input }) => {
      const userConfig = requireBootstrap().userConfig;
      userConfig.setSettings({ weqAssistant: { port: input.port } });
      await getAppContext().applyWeqAssistant(userConfig.getSettings().weqAssistant);
      return userConfig.getSettings().weqAssistant;
    }),

  // ---- first-run onboarding (欢迎使用) ----

  /** True once the user confirmed the first-run 欢迎使用 dialog. */
  getWelcomeAcknowledged: procedure.query(() => {
    return requireBootstrap().userConfig.isWelcomeAcknowledged();
  }),

  /** Mark the first-run 欢迎使用 dialog as confirmed (persists to config.json). */
  acknowledgeWelcome: procedure.mutation(() => {
    requireBootstrap().userConfig.acknowledgeWelcome();
    return true;
  }),

  // ---- voice transcription models (设置 → 语音转录) ----

  /** The model registry, each entry enriched with on-disk / in-flight state. */
  voiceModels: procedure.query(() => {
    return requireBootstrap().voiceTranscribe.listModels();
  }),

  /**
   * Start downloading a model (fire-and-forget). Progress is delivered via the
   * `onVoiceModelProgress` subscription; returns immediately so the renderer's
   * mutation doesn't block on a 245 MB download.
   */
  downloadVoiceModel: procedure.input(z.object({ id: z.string().min(1) })).mutation(({ input }) => {
    // Don't await — the subscription drives the UI. Swallow rejections here;
    // the terminal 'progress' event already carries the error.
    void requireBootstrap()
      .voiceTranscribe.downloadModel(input.id)
      .catch(() => {});
    return true;
  }),

  /** Subscribe to voice-model download progress (all models share one stream). */
  onVoiceModelProgress: procedure.subscription(() => {
    return observable<VoiceDownloadProgress>((emit) => {
      const handler = (p: VoiceDownloadProgress): void => emit.next(p);
      const svc = requireBootstrap().voiceTranscribe;
      svc.on('progress', handler);
      return () => {
        svc.off('progress', handler);
      };
    });
  }),

  /** Delete a downloaded model's files. No-op while a download is in flight. */
  deleteVoiceModel: procedure.input(z.object({ id: z.string().min(1) })).mutation(({ input }) => {
    return requireBootstrap().voiceTranscribe.deleteModel(input.id);
  }),

  /** Set (or clear with '') the selected transcription model id. */
  setVoiceModel: procedure.input(z.object({ modelId: z.string() })).mutation(({ input }) => {
    requireBootstrap().userConfig.setSettings({ voiceTranscribe: { modelId: input.modelId } });
    return true;
  }),

  // ---- agent lab provider config ----

  getAgentLabCatalog: procedure.query(() => {
    return requireBootstrap().agentLabConfig.listCatalog();
  }),

  listAgentLabProviders: procedure.query(() => {
    return requireBootstrap().agentLabConfig.listProviders();
  }),

  saveAgentLabProvider: procedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        vendor: z.string().min(1),
        baseUrl: z.string().min(1),
        apiKey: z.string().min(1),
        models: z
          .array(
            z.object({
              id: z.string().min(1),
              label: z.string().optional(),
              capabilities: z.array(z.enum(['chat', 'embedding', 'vision'])),
            }),
          )
          .default([]),
      }),
    )
    .mutation(({ input }) => {
      return requireBootstrap().agentLabConfig.saveProvider(input);
    }),

  deleteAgentLabProvider: procedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireBootstrap().agentLabConfig.deleteProvider(input.id);
    }),

  /** 「测试连通性」：用表单里的 base_url + api_key + 某个 chat 模型探活，返回详细错误（含状态码/响应体）。 */
  testAgentLabProvider: procedure
    .input(
      z.object({
        baseUrl: z.string().min(1),
        apiKey: z.string().default(''),
        model: z.string().min(1),
      }),
    )
    .mutation(({ input }) => {
      return requireBootstrap().agentLabConfig.testEndpoint(input);
    }),

  // ---- TTS 服务商（设置 → 语音配置；克隆体发语音/语音克隆用）----

  /** 厂商模板（新建 provider 一键带入 + 表单字段提示）。 */
  getTtsCatalog: procedure.query(() => {
    return requireBootstrap().tts.listCatalog();
  }),

  /** 已保存的 TTS 服务商列表。 */
  listTtsProviders: procedure.query(() => {
    return requireBootstrap().userConfig.getSettings().voiceTranscribe.ttsProviders;
  }),

  /** 新增/更新一个 TTS 服务商（按 id upsert，保留 createdAt）。 */
  saveTtsProvider: procedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        vendor: z.enum([
          'openai-compatible',
          'gsv2p',
          'minimax',
          'mimo',
          'doubao',
          'gpt-sovits',
          'cosyvoice',
        ]),
        baseUrl: z.string().min(1),
        apiKey: z.string().default(''),
        appId: z.string().optional(),
        resourceId: z.string().optional(),
        model: z.string().optional(),
        cloneModel: z.string().optional(),
        voice: z.string().optional(),
        format: z.string().optional(),
        speed: z.number().optional(),
      }),
    )
    .mutation(({ input }) => {
      const cfg = requireBootstrap().userConfig;
      const now = Date.now();
      const existing = cfg.getSettings().voiceTranscribe.ttsProviders;
      const prior = existing.find((p) => p.id === input.id);
      const saved: TtsProviderConfig = {
        ...input,
        createdAt: prior?.createdAt ?? now,
        updatedAt: now,
      };
      const next = [...existing.filter((p) => p.id !== input.id), saved].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      cfg.setSettings({ voiceTranscribe: { ttsProviders: next } });
      return saved;
    }),

  /** 删除一个 TTS 服务商。 */
  deleteTtsProvider: procedure.input(z.object({ id: z.string().min(1) })).mutation(({ input }) => {
    const cfg = requireBootstrap().userConfig;
    const next = cfg.getSettings().voiceTranscribe.ttsProviders.filter((p) => p.id !== input.id);
    cfg.setSettings({ voiceTranscribe: { ttsProviders: next } });
    return true;
  }),

  /** 「测试」：用该配置合成一句样例，返回 base64 供前端试听。 */
  testTtsProvider: procedure
    .input(
      z.object({
        id: z.string().default('test'),
        name: z.string().default('test'),
        vendor: z.enum([
          'openai-compatible',
          'gsv2p',
          'minimax',
          'mimo',
          'doubao',
          'gpt-sovits',
          'cosyvoice',
        ]),
        baseUrl: z.string().min(1),
        apiKey: z.string().default(''),
        appId: z.string().optional(),
        resourceId: z.string().optional(),
        model: z.string().optional(),
        cloneModel: z.string().optional(),
        voice: z.string().optional(),
        format: z.string().optional(),
        speed: z.number().optional(),
      }),
    )
    .mutation(({ input }) => {
      const now = Date.now();
      const cfg: TtsProviderConfig = { ...input, createdAt: now, updatedAt: now };
      return requireBootstrap().tts.testProvider(cfg);
    }),

  // ---- cache directory (设置 → 账号信息 → 账号缓存路径) ----

  /** Effective / override / default cache paths for display. */
  getCacheDir: procedure.query(() => {
    return requireBootstrap().userConfig.getCacheDirInfo();
  }),

  /** Folder dialog → set the cache override. Returns the new path info. */
  pickCacheDir: procedure.mutation(async () => {
    const boot = requireBootstrap();
    const picked = await getHost().pickDirectory({ title: '选择缓存目录' });
    if (picked) boot.userConfig.setCacheDirOverride(picked);
    return boot.userConfig.getCacheDirInfo();
  }),

  /** Clear the cache override (revert to the default). Returns new path info. */
  clearCacheDir: procedure.mutation(() => {
    const boot = requireBootstrap();
    boot.userConfig.setCacheDirOverride(null);
    return boot.userConfig.getCacheDirInfo();
  }),

  /**
   * Per-category size of the clearable WeQ caches (头像/媒体/商城表情/语音).
   * Only these re-downloadable/re-generatable categories are listed —
   * agentlab / weq-assistant / export are user content and stay untouched.
   */
  listClearableCache: procedure.query(async () => {
    return requireBootstrap().userConfig.listClearableCache();
  }),

  /** Delete the given clearable cache categories (all when omitted). */
  clearWeqCache: procedure
    .input(z.object({ ids: z.array(z.string()).optional() }).optional())
    .mutation(async ({ input }) => {
      return requireBootstrap().userConfig.clearCache(input?.ids);
    }),

  // ---- filesystem dialog (Tencent Files fallback / manual db pick) ----

  pickTencentFilesRoot: procedure.mutation(async (): Promise<PickRootResult> => {
    const picked = await getHost().pickDirectory({
      title: '选择 Tencent Files 目录（必须选到 Tencent Files 文件夹本身）',
    });
    if (!picked) return { ok: false, path: null };
    // Hard rule: the override must point at the `Tencent Files` folder itself,
    // not a parent or the per-account `…\Tencent Files\<uin>` subdir. Reject
    // anything else so the user gets a clear message instead of a silent miss.
    if (!isTencentFilesRoot(picked)) {
      logger.warn('rejected non-Tencent-Files data dir pick', {
        event: 'pick-root-rejected',
        picked,
      });
      return {
        ok: false,
        path: picked,
        error:
          '请选择名为「Tencent Files」的文件夹本身（不要选里面的 QQ 号子目录，也不要选它的上级目录）。',
      };
    }
    requireBootstrap().globalConfig.setTencentFilesRootOverride(picked);
    logger.info('set Tencent Files data dir override', {
      event: 'pick-root-accepted',
      picked,
    });
    return { ok: true, path: picked };
  }),

  pickMsgDb: procedure.mutation(async () => {
    return getHost().pickFile({ title: '选择 nt_msg.db', extensions: ['db'] });
  }),

  pickStaticDbDir: procedure.mutation(async () => {
    return getHost().pickDirectory({ title: '选择已解密的 QQ 数据库目录' });
  }),

  // ---- key correctness probe ----

  /**
   * Test a dbkey against an account's `nt_msg.db` without opening a session.
   * Returns the resolved algorithms on success so `openAccount` can reuse
   * them (no double probe). This is the gate the UI runs before "进入".
   */
  testDatabaseKey: procedure
    .input(z.object({ uin: z.string(), dbKey: z.string(), dbPathOverride: z.string().optional() }))
    .mutation(async ({ input }) => {
      const platform = requirePlatform();
      if (!input.dbPathOverride) await ensureUidForUin(requireBootstrap(), input.uin);
      const dbPath = input.dbPathOverride ?? platform.ntMsgDbPath(input.uin);
      if (!dbPath || !existsSync(dbPath)) {
        return { success: false as const, error: `未找到该账号的 nt_msg.db（uin=${input.uin}）` };
      }
      try {
        const probe = await platform.native.ntHelper.testDatabaseKey(dbPath, input.dbKey);
        if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
          return { success: false as const, error: '数据库密钥不正确' };
        }
        return {
          success: true as const,
          algo: {
            pageHmacAlgorithm: probe.pageHmacAlgorithm,
            kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
          },
        };
      } catch (e) {
        return { success: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  // ---- key flows ----

  /**
   * Flow 1, step A — inject the hook into the alive QQ instance and block until
   * it is ready to send OIDB packets (the native call waits for the hook to
   * bind the MSFService instance via `uin`). On linux this is the
   * pkexec-elevated ptrace inject, so it pops the polkit password dialog and can
   * take arbitrarily long (the user typing their password) — the renderer
   * awaits this UNTIMED, then runs `fetchKeyFromInstance` (step B). Idempotent
   * inside the hook. No-op-ish on win32 (ensure == inject).
   */
  prepareInstanceInject: procedure
    .input(z.object({ pid: z.number().int().positive(), uin: z.string() }))
    .mutation(async ({ input }) => {
      const boot = requireBootstrap();
      logger.info('router preparing instance inject (untimed)', {
        event: 'router-prepare-inject',
        pid: input.pid,
        uin: input.uin,
      });
      try {
        await boot.injectHook.inject(input.pid, input.uin);
        return { ok: true as const };
      } catch (e) {
        logger.warn('prepareInstanceInject failed', {
          event: 'router-prepare-inject-failed',
          pid: input.pid,
          error: e instanceof Error ? e.message : String(e),
        });
        return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  /**
   * Flow 1 — alive QQ instance. Caller passes pid + uin; we resolve the
   * account's nt_msg.db via the platform (never trust a client-built path —
   * that leaked Windows separators onto linux), inject the embedded hook
   * (idempotent inside native), then ask for the key.
   */
  fetchKeyFromInstance: procedure
    .input(z.object({ pid: z.number().int().positive(), uin: z.string() }))
    .mutation(async ({ input }) => {
      const platform = requirePlatform();
      const boot = requireBootstrap();
      // On linux the account dir is derived from uid, which isn't in the config
      // yet during login. Seed it from the decrypted login.db account list so
      // `platform.ntMsgDbPath(uin)` can resolve the dir this call.
      await ensureUidForUin(boot, input.uin);
      // Resolve the db path from the platform so the layout (win `<uin>/nt_qq/…`
      // vs linux `nt_qq_<hash>/…`) and separators are always correct.
      const dbPath = platform.ntMsgDbPath(input.uin);
      if (!dbPath || !existsSync(dbPath)) {
        logger.warn('key fetch aborted: db file not found', {
          event: 'router-fetch-key-missing-db',
          pid: input.pid,
          uin: input.uin,
          dbPath: dbPath ?? null,
        });
        return {
          success: false as const,
          error: dbPath ? `未找到数据库文件：${dbPath}` : `未找到账号 ${input.uin} 的数据库目录`,
        };
      }
      logger.info('router requested key from running instance', {
        event: 'router-fetch-key-from-instance',
        pid: input.pid,
        dbPath,
      });

      // Make the pid sendable (idempotent). On win32 this injects the embedded
      // hook once; on linux it pkexec-elevates the inject — the native call
      // blocks until the hook binds the MSFService instance via `uin`.
      // Re-injecting a live pid would race the hook's single-listener pipe
      // (ERROR_PIPE_BUSY), so the hook's per-pid cache ensures we only do it
      // once.
      await boot.injectHook.ensure(input.pid, input.uin);

      let result = await boot.keys.fetchFromInstance(input.pid, dbPath);
      if (!result.success) {
        // The cached native client may have died (QQ relaunched / hook
        // unloaded). Reset + re-ensure once — a genuinely closed client
        // reconnects cleanly — and retry a single time.
        logger.warn('key fetch failed; re-injecting and retrying once', {
          event: 'router-fetch-key-retry',
          pid: input.pid,
          error: result.error,
        });
        boot.injectHook.reset(input.pid);
        await boot.injectHook.ensure(input.pid, input.uin);
        result = await boot.keys.fetchFromInstance(input.pid, dbPath);
      }
      return result;
    }),

  /**
   * Flow 2 — quick login. Subscription so the renderer can show
   * "found these accounts in login.db" before the dbkey lands.
   */
  quickLogin: procedure
    .input(
      z.object({
        uin: z.string(),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .subscription(({ input }) => {
      return observable<KeyEvent>((emit) => {
        const stream = requireBootstrap().keys.quickLoginStream({
          uin: input.uin,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        });
        const iterator = stream[Symbol.asyncIterator]();
        let cancelled = false;

        void (async (): Promise<void> => {
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done || cancelled) break;
              emit.next(next.value);
            }
            emit.complete();
          } catch (e) {
            emit.error(e);
          }
        })();

        return () => {
          cancelled = true;
          void iterator.return?.();
        };
      });
    }),

  /** Flow 3 — QR login. Same shape as quickLogin. */
  qrLogin: procedure
    .input(z.object({ timeoutMs: z.number().int().positive().optional() }).optional())
    .subscription(({ input }) => {
      return observable<KeyEvent>((emit) => {
        const stream = requireBootstrap().keys.qrLoginStream({
          ...(input?.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        });
        const iterator = stream[Symbol.asyncIterator]();
        let cancelled = false;

        void (async (): Promise<void> => {
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done || cancelled) break;
              emit.next(next.value);
            }
            emit.complete();
          } catch (e) {
            emit.error(e);
          }
        })();

        return () => {
          cancelled = true;
          void iterator.return?.();
        };
      });
    }),

  // ---- account open / close ----

  /**
   * Open an account session. Caller supplies uin + dbkey, optionally the
   * pre-probed `algo` (from `testDatabaseKey`) and display metadata that gets
   * persisted into the saved-config record (keyed by data directory).
   *
   * When `algo` is absent we probe it here (also acting as a key-correctness
   * gate). Throws on a wrong key so the renderer surfaces an error dialog.
   */
  openAccount: procedure
    .input(
      z.object({
        uin: z.string(),
        uid: z.string().optional(),
        dbKey: z.string(),
        algo: algoSchema.optional(),
        displayName: z.string().optional(),
        avatarUrl: z.string().optional(),
        dataDir: z.string().optional(),
        /** p_skey the login flow harvested (domain → key). Best-effort. */
        pskey: z.record(z.string(), z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const ctx = getAppContext();
      const platform = requirePlatform();

      // Register the uid→uin mapping BEFORE any path lookup: on linux the
      // account directory is derived from uid, and this is a fresh account
      // whose uid isn't in the saved config yet. Seeding it here lets
      // `platform.ntMsgDbPath(uin)` resolve during this very call. Prefer the
      // uid the caller passed; otherwise recover it from the login.db list.
      if (input.uid) rememberAccountUid(input.uin, input.uid);
      else await ensureUidForUin(requireBootstrap(), input.uin);

      let algos: Record<string, import('@weq/native').DatabaseAlgorithms> = {};
      if (input.algo) {
        algos = { 'nt_msg.db': input.algo };
      } else {
        const msgDbPath = platform.ntMsgDbPath(input.uin);
        if (!msgDbPath) {
          throw new Error(`nt_msg.db not found for uin=${input.uin}`);
        }
        const probe = await platform.native.ntHelper.testDatabaseKey(msgDbPath, input.dbKey);
        if (!probe.success || !probe.pageHmacAlgorithm || !probe.kdfHmacAlgorithm) {
          throw new Error('数据库密钥不正确，无法打开。');
        }
        algos = {
          'nt_msg.db': {
            pageHmacAlgorithm: probe.pageHmacAlgorithm,
            kdfHmacAlgorithm: probe.kdfHmacAlgorithm,
          },
        };
      }

      const dataDir =
        input.dataDir ?? requireBootstrap().globalConfig.accountDataDir(input.uin) ?? undefined;

      await ctx.setAccount(
        { uin: input.uin, dbKey: input.dbKey, algos },
        {
          ...(input.uid ? { uid: input.uid } : {}),
          ...(input.displayName ? { displayName: input.displayName } : {}),
          ...(input.avatarUrl ? { avatarUrl: input.avatarUrl } : {}),
          ...(dataDir ? { dataDir } : {}),
        },
      );
      // Must land AFTER setAccount — that's what seeds the config record the
      // patch writes into.
      if (input.pskey && Object.keys(input.pskey).length > 0) {
        const services = ctx.services;
        const session = ctx.account;
        services?.accountConfig.setLoginPskey(input.pskey);

        // The login flow already killed QQ, so `monitor.harvest` (which needs a
        // live, hooked pid) will never run for this open — fetch the home-dress
        // snapshot here instead, off the seeded ticket. pid=0 is never dialled:
        // the seed short-circuits the p_skey lookup. Fire-and-forget so a slow
        // CDN can't hold up entering the account.
        if (services && session) {
          void fetchHomeDress(platform.native.ntHelper, session, 0, input.pskey)
            .then(async (dress) => {
              services.accountConfig.setHomeDress(dress);
              // 顺手把手机 QQ 正在用的气泡/字体装上并切过去。只在用户从没自己选过时
              // 动手，内部逐项静默失败（见 syncFromQq）。
              await services.dressInstall.syncFromQq(dress);
              emitDressChanged();
            })
            .catch((e) => {
              logger.warn('home dress fetch from login pskey failed (non-fatal)', {
                event: 'router-home-dress-failed',
                accountUin: input.uin,
                ...logErrorContext(e),
              });
            });
        }
      }
      return ctx.account!.context;
    }),

  closeAccount: procedure.mutation(() => {
    logger.info('router closing account', { event: 'router-close-account' });
    getAppContext().clearAccount();
    return true;
  }),

  // ---- static (offline) account from local databases ----

  /**
   * Probe a directory of local QQ databases. Tries to read the self row
   * from `profile_info_v6` so the UI can show the resolved UIN / nickname
   * before committing to an open.
   *
   *   - No key, plain SQLite succeeds → returns `{ ok: true, needKey: false, preview }`
   *   - SQLCipher with correct key    → same
   *   - SQLCipher without key (or wrong key) → `{ ok: true, needKey: true }`
   *     (needKey=true is not a hard error; the UI then prompts for a key)
   *   - Missing files / corrupt db   → `{ ok: false, error }`
   */
  testStaticDir: procedure
    .input(
      z.object({
        dirPath: z.string().min(1),
        dbKey: z.string().optional(),
        algo: algoSchema.optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const platform = requirePlatform();
      if (!existsSync(input.dirPath)) {
        return { ok: false as const, error: `目录不存在：${input.dirPath}` };
      }
      const profileInfoPath = join(input.dirPath, 'profile_info.db');
      const ntMsgPath = join(input.dirPath, 'nt_msg.db');
      if (!existsSync(profileInfoPath)) {
        return { ok: false as const, error: '未在所选目录中找到 profile_info.db' };
      }
      if (!existsSync(ntMsgPath)) {
        return { ok: false as const, error: '未在所选目录中找到 nt_msg.db' };
      }
      // 用户没给密钥时，先试着自己算 —— 安卓备份目录能从 uid + 头里的
      // rand 推出 dbkey，省掉手输那一步。算不出来再走原来的流程。
      let dbKey = input.dbKey;
      let algos: Record<string, import('@weq/native').DatabaseAlgorithms> | undefined = input.algo
        ? { 'nt_msg.db': input.algo }
        : undefined;
      let derived = false;
      if (!dbKey) {
        const d = await deriveAndroidDbKey(platform.native.ntHelper, input.dirPath);
        if (d) {
          dbKey = d.dbKey;
          algos = d.algos;
          derived = true;
        }
      }

      try {
        const preview = await peekStaticSelfUin(platform, input.dirPath, dbKey, algos);
        return {
          ok: true as const,
          needKey: false as const,
          // 自动算出来的密钥要回给前端 —— 「进入」时要用它开库并持久化。
          ...(derived && dbKey ? { derivedKey: dbKey } : {}),
          // 能自动推导密钥 ⇒ 安卓手机备份目录，标记为 mobile。
          ...(derived ? { mobile: true as const } : {}),
          preview: {
            uin: preview.uin,
            uid: preview.uid,
            displayName: preview.nick,
            avatarUrl: preview.avatarUrl,
          },
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // 用户没给密钥（自动派生也没成）—— 让 UI 去要，不算硬错误。
        if (!input.dbKey) {
          return { ok: true as const, needKey: true as const };
        }
        return { ok: false as const, error: `无法打开数据库：${msg}` };
      }
    }),

  /**
   * Open a static (offline) account. The caller must have already resolved
   * a self preview (UIN + nick) via `testStaticDir`; we don't trust the
   * directory name as a UIN. `dbKey` is required for SQLCipher backups;
   * omit it for already-decrypted plain SQLite folders.
   */
  openStaticAccount: procedure
    .input(
      z.object({
        dirPath: z.string().min(1),
        dbKey: z.string().optional(),
        algo: algoSchema.optional(),
        mobile: z.boolean().optional(),
        preview: z.object({
          uin: z.string().min(1),
          // Needed to derive the account directory on linux (`nt_qq_<hash>` is
          // keyed by uid, not uin) — both for the native-media probe and for
          // `isQqLoggedIn`. Optional so a client from an older build still opens.
          uid: z.string().default(''),
          displayName: z.string(),
          avatarUrl: z.string(),
        }),
      }),
    )
    .mutation(async ({ input }) => {
      const ctx = getAppContext();
      if (!existsSync(input.dirPath)) {
        throw new Error(`目录不存在：${input.dirPath}`);
      }
      const ntMsgPath = join(input.dirPath, 'nt_msg.db');
      if (!existsSync(ntMsgPath)) {
        throw new Error(`未在所选目录中找到 nt_msg.db：${input.dirPath}`);
      }
      // 没带密钥时同样先自己算一遍 —— 覆盖「重开已存账号」以及旧版前端
      // 不回传 derivedKey 的情况。算不出来就按明文 SQLite 打开（原行为）。
      let dbKey = input.dbKey;
      let algos: Record<string, import('@weq/native').DatabaseAlgorithms> | undefined = input.algo
        ? { 'nt_msg.db': input.algo }
        : undefined;
      if (!dbKey) {
        const d = await deriveAndroidDbKey(requirePlatform().native.ntHelper, input.dirPath);
        if (d) {
          dbKey = d.dbKey;
          algos = d.algos;
        }
      }

      await ctx.setStaticAccount(input.dirPath, input.preview, {
        ...(dbKey ? { dbKey } : {}),
        ...(algos ? { algos } : {}),
        ...(input.mobile ? { mobile: true } : {}),
      });
      return ctx.account!.context;
    }),

  /** True if an account session is currently open. */
  accountOpen: procedure.query(() => {
    return getAppContext().account !== null;
  }),
});

// Sanity helper — kept exported so consumers can guard against junk paths
// from the dialog without re-importing fs everywhere.
export function tencentFilesLooksReal(root: string): boolean {
  return existsSync(join(root, 'nt_qq')) || existsSync(join(root));
}
