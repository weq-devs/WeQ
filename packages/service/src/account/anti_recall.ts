/**
 * 防撤回配置与运行状态。三种保护方式共用会话名单，原有配置迁移为数据库触发器方式。
 * WeQ 原文副本按账号来源持久保存，数据库监听与代理推送汇入同一撤回记录。
 * 配置保存后串行应用触发器；状态返回实际读回的安装结果及应用中的标记。
 */

import {
  QqDb,
  AntiRecallDb,
  withDatabaseSignal,
  withDatabasePriority,
  assertDatabaseWritable,
  type AntiRecallTarget,
  type AntiRecallTriggerInfo,
  type RecallBaseline,
  type RecallConvSummary,
  type RecallCursor,
  type RecallLogRow,
} from '@weq/db';
import { isDatalineUid } from '@weq/codec';
import { type AccountSession, algoFor } from '@weq/account';
import type { Platform } from '@weq/platform';
import { JsonStore } from '../common/json_store';
import type { PreferencePersistence } from '../common/shared_preferences';
import { DbWatchService, type DbWatchHandle, type DbWatchTask } from './db_watch';
import { RecallArchive } from './recall_archive';
import { createNtMsgDbHook } from './nt_msg_hook';
import type { GapFetchedMessage } from './gap_history';
import { getLogger, logErrorContext } from '../common/logger';

const logger = getLogger().child({ scope: 'anti-recall' });

/** Persisted anti-recall config for one account. */
export type AntiRecallMethod = 'weq' | 'proxy' | 'database';

export interface AntiRecallConfig {
  method?: AntiRecallMethod;
  /** 总开关；关闭后停止收集和过滤，并卸下触发器。 */
  enabled: boolean;
  /**
   * `'selected'` — only `targets` are protected.
   * `'all'` (default) — every conversation is protected (永久全选，不做会话筛选);
   * `targets` is ignored while this mode is active, but kept in the config so
   * switching back to `'selected'` restores the prior selection.
   */
  mode: 'selected' | 'all';
  /** Conversations the user chose to protect (used when `mode === 'selected'`). */
  targets: AntiRecallTarget[];
  /** 旧版通知总开关；宿主接入统一渠道后由当前渠道决定。 */
  notifyEnabled: boolean;
  /**
   * Conversations whose recalls raise a notification, keyed `${kind}:${id}`
   * (e.g. `group:12345`, `c2c:u_xxxx`). Independent of the protection set: a
   * conversation must be protected for recalls to be recorded at all, but which
   * of them *notify* is a separate, per-conversation choice.
   */
  notifyTargets: string[];
}

/** What the renderer needs to render the settings panel. */
export interface AntiRecallStatus extends AntiRecallConfig {
  settingsRevision?: number;
  /** Triggers actually present in the DB right now (source of truth for state). */
  installed: AntiRecallTriggerInfo[];
  /** True while QQ is running — installs are deferred / the UI warns to restart. */
  qqRunning: boolean;
  proxyConnected?: boolean;
  error?: string;
  applying?: boolean;
  restartSuggested?: boolean;
}

/** One intercepted recall handed to the injected notifier. */
export interface RecallNotifyEvent {
  kind: 'c2c' | 'group' | 'dataline';
  /** Conversation key: peer uid (c2c/dataline) or group code (group). */
  conv: string;
  msgId: string;
  senderUid: string;
  revokeUid: string;
  origSeq: string;
  recallTs: number;
}

export interface AntiRecallOptions {
  readOnly?: boolean;
  archivePath?: string;
  onArchiveChanged?: (message: GapFetchedMessage) => void;
  preferences?: PreferencePersistence<AntiRecallConfig>;
  notificationsEnabled?: () => boolean;
  onObservedRecall?: (event: RecallNotifyEvent) => void;
  /**
   * Raised for every newly-recorded recall in a conversation whose notification
   * switch is on. Implemented in the Electron main process (native notification
   * + click-to-jump); the service layer stays platform-free.
   */
  onRecall?: (event: RecallNotifyEvent) => void;
}

const DEFAULT_CONFIG: AntiRecallConfig = {
  enabled: false,
  mode: 'all',
  method: 'database',
  targets: [],
  notifyEnabled: false,
  notifyTargets: [],
};

export { DEFAULT_CONFIG as DEFAULT_ANTI_RECALL_CONFIG };

/** Conversation key used by {@link AntiRecallConfig.notifyTargets}. */
export function notifyKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * 归一化一个 target 的 kind，修复前端对临时会话的误判。
 *
 * 真群号是纯数字，uid 一定是 `u_` 开头。有些临时会话（群临时会话/频道等）chatType
 * 名字里带 'GROUP'，却把 uid 存进 targetUid —— 前端可能把它错标成 group，塞进 group
 * 触发器的 40027(数字) IN 列表，导致永不命中、完全不受保护（已在真实库用
 * diag_dirty_conv.ts 证实这类会话消息都在 c2c_msg_table）。
 *
 * 这里兜底：id 以 `u_` 开头却标了 group 的，一律改回 c2c（走 40021）。既清洗历史脏
 * 配置（load 时自愈），也防前端漏网（setTargets 时再校一遍）。dataline 保持不动。
 */
function normalizeTarget(t: AntiRecallTarget): AntiRecallTarget {
  if (t.kind === 'group' && t.id.startsWith('u_')) {
    return { kind: 'c2c', id: t.id };
  }
  return { kind: t.kind, id: t.id };
}

export class AntiRecallService {
  /** 配置的整文件存储（内存态即真源，save() 原子落盘）。 */
  private readonly configStore: JsonStore<AntiRecallConfig>;
  /** nt_msg.db 的变更监听（只为「有新撤回记录」这一件事而挂）。 */
  private monitor: DbWatchService | null = null;
  private monitorHandle: DbWatchHandle | null = null;
  private monitorReads: AbortController | null = null;
  private monitorGeneration = 0;
  private reconcileAbort = new AbortController();
  private recallBaseline: Promise<void> | null = null;
  /** 记录最后一秒已交付的撤回，下一次读取仍包含这一秒。 */
  private lastRecall: RecallBaseline | null = null;
  readonly archive?: RecallArchive;
  private proxyConnected = false;
  private error = '';
  private proxyError = '';
  private restartSuggested = false;
  private installed: AntiRecallTriggerInfo[] = [];
  private applying = false;
  private reconcileQueue: Promise<void> = Promise.resolve();
  private reconcileRevision = 0;
  private snapshotScanPending = false;
  private snapshotBaselining = true;
  private readonly startedAtSeconds = Math.floor(Date.now() / 1000);
  private snapshotScan: Promise<void> | null = null;
  private readonly deliveredRecalls = new Set<string>();

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    storePath: string,
    private readonly opts: AntiRecallOptions = {},
  ) {
    this.configStore = new JsonStore(storePath, () => ({ ...DEFAULT_CONFIG }), {
      persistence: opts.preferences,
      strict: Boolean(opts.preferences),
      normalize: (raw) => {
        const parsed = (raw ?? {}) as Partial<AntiRecallConfig>;
        return {
          enabled: parsed.enabled === true,
          mode:
            parsed.mode === 'selected' || parsed.mode === 'all' ? parsed.mode : DEFAULT_CONFIG.mode,
          method: parsed.method === 'weq' || parsed.method === 'proxy' ? parsed.method : 'database',
          targets: Array.isArray(parsed.targets)
            ? parsed.targets
                .filter(
                  (t): t is AntiRecallTarget =>
                    !!t &&
                    typeof t.id === 'string' &&
                    (t.kind === 'c2c' || t.kind === 'group' || t.kind === 'dataline'),
                )
                .map(normalizeTarget)
            : [],
          notifyEnabled: parsed.notifyEnabled === true,
          notifyTargets: Array.isArray(parsed.notifyTargets)
            ? parsed.notifyTargets.filter((k): k is string => typeof k === 'string' && k !== '')
            : [],
        };
      },
    });
    if (opts.archivePath && !opts.readOnly)
      this.archive = new RecallArchive(
        platform.native.ntHelper,
        opts.archivePath,
        (kind, conv) => this.protects(kind, conv),
        (message) => {
          this.publishRecall({
            kind: isDatalineUid(message.conv) ? 'dataline' : message.kind,
            conv: message.conv,
            msgId: message.msgId,
            senderUid: message.senderUid,
            revokeUid: message.recall!.revokeUid,
            origSeq: message.msgSeq,
            recallTs: message.recall!.recallTs,
          });
          opts.onArchiveChanged?.(message);
        },
      );
    if (opts.preferences) this.reconcileInBackground();
  }

  /** 当前配置（内存态）。 */
  private get config(): AntiRecallConfig {
    return this.configStore.data;
  }

  private set config(next: AntiRecallConfig) {
    this.configStore.replace(next);
  }

  /** 缓存消息与 QQ 原库使用同一份保护范围。 */
  protects(kind: 'c2c' | 'group', conv: string): boolean {
    return (
      this.config.enabled &&
      (this.config.mode === 'all' ||
        this.config.targets.some(
          (target) =>
            (target.kind === kind || (kind === 'c2c' && target.kind === 'dataline')) &&
            target.id === conv,
        ))
    );
  }

  protection() {
    return {
      enabled: this.config.enabled,
      method: this.config.method ?? 'database',
      mode: this.config.mode,
      targets: this.config.targets,
    };
  }
  setProxyState(connected: boolean, error = '') {
    this.proxyConnected = connected;
    this.proxyError = error;
  }
  async setMethod(method: 'off' | AntiRecallMethod): Promise<AntiRecallStatus> {
    const prior = this.config.enabled ? (this.config.method ?? 'database') : 'off';
    if (prior !== method && (prior === 'database' || method === 'database') && this.isQqRunning())
      this.restartSuggested = true;
    this.config = {
      ...this.config,
      enabled: method !== 'off',
      method: method === 'off' ? this.config.method : method,
    };
    this.resetRecallBaseline();
    this.reconcileInBackground();
    return this.optimisticStatus();
  }
  private publishRecall(event: RecallNotifyEvent) {
    if (this.archive && (this.snapshotBaselining || event.recallTs < this.startedAtSeconds)) return;
    const key = `${event.kind}:${event.conv}:${event.msgId}`;
    if (this.deliveredRecalls.has(key)) return;
    this.deliveredRecalls.add(key);
    if (this.deliveredRecalls.size > 10000)
      this.deliveredRecalls.delete(this.deliveredRecalls.values().next().value!);
    this.opts.onObservedRecall?.(event);
    if (
      this.config.notifyTargets.includes(notifyKey(event.kind, event.conv)) &&
      this.notificationsEnabled(this.config)
    )
      this.opts.onRecall?.(event);
  }

  /** Current config + live trigger state + whether QQ is running. */
  async getStatus(): Promise<AntiRecallStatus> {
    const installed = this.opts.readOnly ? [] : await this.openDb().status();
    this.installed = installed;
    return {
      ...this.config,
      notifyEnabled: this.notificationsEnabled(this.config),
      settingsRevision: this.opts.preferences?.revision?.(),
      installed,
      proxyConnected: this.proxyConnected,
      error: this.error || (this.protection().method === 'database' ? '' : this.proxyError),
      applying: this.applying,
      restartSuggested: this.restartSuggested,
      qqRunning: this.isQqRunning(),
    };
  }

  /**
   * The recorded recalls for one conversation, newest-first — read straight from
   * the `weq_recall_log` table the trigger writes to. Empty when the feature was
   * never enabled (the table doesn't exist yet — {@link AntiRecallDb.listRecalls}
   * handles that). Drives the 「撤回记录」面板.
   */
  async listRecalls(kind: 'c2c' | 'group', conv: string): Promise<RecallLogRow[]> {
    const db = this.openDb();
    const rows = await db.listRecalls(kind, conv);
    if (kind !== 'c2c') return rows;
    // 数据线（我的手机 / 我的电脑）在消息库里是**独立一张表**、触发器也单独一张，
    // 但会话 key 与私聊同为 40021 的 uid。面板 / 消息标记只知道 'c2c' 这一档，
    // 所以这里把 dataline 的记录一起取回 —— 同一个 conv 不会同时出现在两张表里，
    // 合并无副作用，却让数据线的撤回记录也能看见。
    const dataline = await db.listRecalls('dataline', conv);
    if (dataline.length === 0) return rows;
    return [...rows, ...dataline].sort((a, b) => b.recallTs - a.recallTs);
  }

  /**
   * Per-conversation summary of the recorded recalls (count + last time),
   * most recently active first — the directory behind the 「撤回记录」集成页.
   * Rows without a usable conversation key are dropped.
   */
  async listRecallConversations(): Promise<RecallConvSummary[]> {
    const summaries = await this.openDb().recallSummaries();
    return summaries.filter((s) => s.conv !== '');
  }

  /**
   * A `msgId → recall info` map for one conversation, so a message page can be
   * tagged in a single DB read instead of one lookup per message. Consumed by
   * {@link MsgService} to attach `recall` to each rendered message.
   */
  async getRecallMap(
    kind: 'c2c' | 'group',
    conv: string,
    msgIds?: readonly bigint[],
  ): Promise<Map<string, { revokeUid: string; senderUid: string; recallTs: number }>> {
    // 页面读取复用账号的同库连接；不在每页结束时关闭整个 native 连接缓存。
    const db = this.openDb();
    const rows = await db.listRecalls(kind === 'c2c' ? ['c2c', 'dataline'] : kind, conv, msgIds);
    const map = new Map<string, { revokeUid: string; senderUid: string; recallTs: number }>();
    for (const r of rows) {
      map.set(r.msgid, { revokeUid: r.revokeUid, senderUid: r.senderUid, recallTs: r.recallTs });
    }
    return map;
  }

  listRecallRefs(...args: Parameters<AntiRecallDb['listRecallRefs']>) {
    return this.openDb().listRecallRefs(...args);
  }

  /** Flip the master switch, then reconcile triggers to match. Persists. */
  async setEnabled(enabled: boolean): Promise<AntiRecallStatus> {
    if (!this.opts.readOnly) assertDatabaseWritable(this.session.msgDbPath);
    this.config = { ...this.config, enabled };
    // (重新)开启保护时重建通知基线：历史记录不该在新一轮里弹出来。
    this.resetRecallBaseline();
    this.reconcileInBackground();
    return this.optimisticStatus();
  }

  /**
   * 设置「启用范围」——关闭 / 仅按会话勾选 / 永久全选。
   *
   * 取代旧版「总开关 + 保护范围」两段式：关闭即不装触发器，选择会话或全部时
   * 自动启用。UI 只调用这一个入口，MCP 的 setEnabled/setMode 仍保留兼容。
   */
  async setScope(scope: 'off' | 'selected' | 'all'): Promise<AntiRecallStatus> {
    if (!this.opts.readOnly) assertDatabaseWritable(this.session.msgDbPath);
    const enabled = scope !== 'off';
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, enabled, ...(scope === 'off' ? {} : { mode: scope }) };
    if (enabled && !wasEnabled) this.resetRecallBaseline();
    this.reconcileInBackground();
    return this.optimisticStatus();
  }

  /**
   * Switch between protecting only `targets` (`'selected'`) and protecting
   * every conversation with no session filter (`'all'`, 永久全选). Persists.
   */
  async setMode(mode: 'selected' | 'all'): Promise<AntiRecallStatus> {
    if (!this.opts.readOnly) assertDatabaseWritable(this.session.msgDbPath);
    this.config = { ...this.config, mode };
    this.reconcileInBackground();
    return this.optimisticStatus();
  }

  /** Replace the protected-conversation set, then reconcile. Persists. */
  async setTargets(targets: AntiRecallTarget[]): Promise<AntiRecallStatus> {
    if (!this.opts.readOnly) assertDatabaseWritable(this.session.msgDbPath);
    // Normalize (u_ ids can't be group codes), drop empty ids, de-dup by (kind,id)
    // so the trigger's IN-list is clean and every id lands in the right column.
    const seen = new Set<string>();
    const clean: AntiRecallTarget[] = [];
    for (const raw of targets) {
      if (!raw.id) continue;
      const t = normalizeTarget(raw);
      const key = `${t.kind}:${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push(t);
    }
    this.config = { ...this.config, targets: clean };
    this.reconcileInBackground();
    return this.optimisticStatus();
  }

  /**
   * Update the notification settings: master switch and/or per-conversation set
   * (keys `${kind}:${id}`). Persists; no trigger reconcile needed.
   */
  async setNotify(input: { enabled?: boolean; targets?: string[] }): Promise<AntiRecallStatus> {
    const next: AntiRecallConfig = { ...this.config };
    if (typeof input.enabled === 'boolean') next.notifyEnabled = input.enabled;
    if (Array.isArray(input.targets)) {
      next.notifyTargets = [...new Set(input.targets.filter((k) => typeof k === 'string' && k))];
    }
    this.config = next;
    return this.optimisticStatus();
  }

  /** 修改当前名单中的单个会话，不覆盖其他客户端刚保存的选择。 */
  async setConversationNotify(
    target: AntiRecallTarget,
    enabled: boolean,
  ): Promise<AntiRecallStatus> {
    const { kind, id } = normalizeTarget(target);
    const key = notifyKey(kind, id);
    const targets = this.config.notifyTargets;
    if (targets.includes(key) === enabled) return this.optimisticStatus();
    return this.setNotify({
      targets: enabled ? [...targets, key] : targets.filter((k) => k !== key),
    });
  }

  /**
   * Mount the recall monitor (nt_msg.db change watch → drain `weq_recall_log`).
   * Idempotent. Independent of whether protection is currently enabled; the drain
   * itself is the thing that gates on config.
   */
  startMonitor(): void {
    if (this.reconcileAbort.signal.aborted) this.reconcileAbort = new AbortController();
    if (this.monitorHandle) return;
    const generation = ++this.monitorGeneration;
    this.monitor = new DbWatchService({ intervalMs: 1_000 });
    const snapshotHook = this.archive
      ? createNtMsgDbHook(this.session, {
          onDbChanged: () => {
            void this.scanSnapshots();
          },
          onNewMessages: async (change) => {
            await this.archive!.observeNative([
              ...change.c2c,
              ...change.group,
              ...(change.dataline ?? []),
            ]);
            await this.scanSnapshots();
          },
        })
      : undefined;
    const task: DbWatchTask = {
      dbPath: this.session.msgDbPath,
      dispose: () => snapshotHook?.dispose?.(),
      onDbFileChangeHook: (file) => {
        const reads = this.monitorReads;
        if (generation !== this.monitorGeneration || !reads) return;
        if (this.config.enabled) snapshotHook?.onDbFileChangeHook(file);
        return withDatabaseSignal(reads.signal, () => this.drainRecalls(reads));
      },
    };
    this.monitorHandle = this.monitor.mount(task);
    this.resetRecallBaseline();
    snapshotHook?.onDbFileChangeHook({
      dbPath: this.session.msgDbPath,
      prevTotal: 0,
      total: 0,
      delta: 0,
      files: [],
      at: Date.now(),
    });
  }

  private async scanSnapshots() {
    if (!this.archive || !this.config.enabled) return;
    if (this.snapshotScan) {
      this.snapshotScanPending = true;
      return;
    }
    const generation = this.monitorGeneration;
    this.snapshotScan = (async () => {
      const ids = await this.archive!.pendingNativeIds();
      const db = new QqDb(this.platform.native.ntHelper, {
        dbPath: this.session.msgDbPath,
        key: this.session.context.dbKey,
        algo: algoFor(this.session.context, this.session.msgDbPath),
      });
      for (const kind of ['c2c', 'group', 'dataline'] as const) {
        if (generation !== this.monitorGeneration) return;
        const selected = ids
          .filter((row) =>
            kind === 'group'
              ? row.kind === 'group'
              : row.kind === 'c2c' && isDatalineUid(row.conv) === (kind === 'dataline'),
          )
          .map((row) => row.id);
        if (!selected.length) continue;
        const table =
          kind === 'group'
            ? 'group_msg_table'
            : kind === 'dataline'
              ? 'dataline_msg_table'
              : 'c2c_msg_table';
        const candidates = await db.query(
          `SELECT "40001" FROM ${table}
          WHERE "40001" IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
          AND instr("40800",X'd0fc1508')>0`,
          [JSON.stringify(selected)],
        );
        if (!candidates.length) continue;
        const source =
          kind === 'group'
            ? this.session.groupMsgs
            : kind === 'dataline'
              ? this.session.datalineMsgs
              : this.session.c2cMsgs;
        const rows = await source.listByMsgIds(candidates.map((row) => BigInt(String(row[0]))));
        await this.archive!.observeNative(rows);
      }
    })()
      .catch((error) => {
        this.error = (error as Error).message;
      })
      .finally(() => {
        this.snapshotBaselining = false;
        this.snapshotScan = null;
        if (this.snapshotScanPending && generation === this.monitorGeneration) {
          this.snapshotScanPending = false;
          void this.scanSnapshots();
        }
      });
    await this.snapshotScan;
  }

  async dispose() {
    this.stopMonitor();
    await this.snapshotScan;
    await this.reconcileQueue;
    await this.archive?.close();
  }

  /** Stop the recall monitor. Idempotent. */
  stopMonitor(): void {
    this.reconcileAbort.abort();
    this.monitorGeneration++;
    this.monitorReads?.abort();
    this.monitorReads = null;
    this.recallBaseline = null;
    this.lastRecall = null;
    this.monitorHandle?.unmount();
    this.monitorHandle = null;
    this.monitor = null;
  }

  /**
   * Make the live triggers match the current config: install for the selected
   * conversations (or every conversation, in `'all'` mode) when enabled, drop
   * everything when disabled.
   *
   * Works whether or not QQ is running — each statement is a short write that
   * releases the lock immediately (see QqDb.write). QQ may keep firing (or not
   * firing) the old triggers from its cached schema until its next restart, so
   * callers surface `qqRunning` as a heads-up.
   */
  async applyTriggers(): Promise<void> {
    if (this.opts.readOnly) return;
    const db = this.openDb();
    try {
      const enabled = this.config.enabled && (this.config.method ?? 'database') === 'database';
      const allConversations = enabled && this.config.mode === 'all';
      const active = enabled ? this.config.targets : [];
      await db.reconcile(active, allConversations);
      this.installed = await db.status();
    } finally {
      db.close();
    }
  }

  /**
   * Run {@link applyTriggers} without blocking the caller — the renderer's
   * settings writes should feel instant even though the trigger DDL is a real
   * (SQLCipher) write. Failures are logged; a later `getStatus` shows reality.
   */
  private reconcileInBackground(): void {
    if (this.opts.readOnly) return;
    this.applying = true;
    const revision = ++this.reconcileRevision;
    this.reconcileQueue = this.reconcileQueue
      .catch(() => undefined)
      .then(() =>
        withDatabasePriority('background', () => this.applyTriggers(), this.reconcileAbort.signal),
      )
      .then(() => {
        if (revision === this.reconcileRevision) this.error = '';
      })
      .catch((error) => {
        if (revision === this.reconcileRevision && !this.reconcileAbort.signal.aborted)
          this.error = (error as Error).message;
      })
      .finally(() => {
        if (revision === this.reconcileRevision) this.applying = false;
      });
  }

  /** 当前配置与最近一次实际读回的触发器状态。 */
  private optimisticStatus(): AntiRecallStatus {
    return {
      ...this.config,
      notifyEnabled: this.notificationsEnabled(this.config),
      settingsRevision: this.opts.preferences?.revision?.(),
      installed: this.installed,
      proxyConnected: this.proxyConnected,
      error: this.error || (this.protection().method === 'database' ? '' : this.proxyError),
      applying: this.applying,
      restartSuggested: this.restartSuggested,
      qqRunning: this.isQqRunning(),
    };
  }

  private notificationsEnabled(config: AntiRecallConfig): boolean {
    return this.opts.notificationsEnabled?.() ?? config.notifyEnabled;
  }

  /**
   * Capture existing recalls on start and whenever protection is (re)enabled.
   */
  private resetRecallBaseline(): void {
    this.lastRecall = null;
    this.monitorReads?.abort();
    this.monitorReads = null;
    this.recallBaseline = null;
    if (!this.monitorHandle) return;
    const reads = new AbortController();
    this.monitorReads = reads;
    const baseline = withDatabaseSignal(reads.signal, () => this.initRecallBaseline(reads));
    this.recallBaseline = baseline;
    void baseline.finally(() => {
      if (this.recallBaseline === baseline) this.recallBaseline = null;
    });
  }

  private monitorCurrent(reads: AbortController): boolean {
    return this.monitorReads === reads && !reads.signal.aborted && this.monitorHandle !== null;
  }

  private async initRecallBaseline(reads: AbortController): Promise<void> {
    try {
      const db = this.openDb();
      const baseline = await db.latestRecallBaseline();
      if (this.monitorCurrent(reads)) this.lastRecall = baseline;
    } catch (error) {
      if (!this.monitorCurrent(reads)) return;
      // Leave the cursor null — the next drain will baseline instead.
      logger.debug('anti-recall baseline failed', {
        event: 'anti-recall-baseline-failed',
        ...logErrorContext(error),
      });
    }
  }

  /**
   * Drain newly-recorded recalls and raise the notification hook for the ones
   * whose conversation opted in. Cheap no-op when protection AND notifications
   * are both off (no trigger can have written anything). Always advances the
   * cursor so enabling a conversation's notification later does not dump the
   * backlog.
   */
  private async drainRecalls(reads: AbortController): Promise<void> {
    if (!this.monitorCurrent(reads)) return;
    const config = this.config;
    if (!config.enabled && (!config.notifyTargets.length || !this.notificationsEnabled(config)))
      return;
    if (this.recallBaseline) await this.recallBaseline;
    if (!this.monitorCurrent(reads)) return;
    // 只读包装复用账号连接；close 会关闭同库其他读者的 native 缓存。
    const db = this.openDb();
    try {
      const last = this.lastRecall;
      if (last === null) {
        await this.initRecallBaseline(reads);
        return;
      }
      let cursor: RecallCursor = { recallTs: last.recallTs };
      for (;;) {
        const rows = await db.listRecallsSince(cursor);
        if (!this.monitorCurrent(reads)) return;
        for (const row of rows) {
          if (!this.monitorCurrent(reads)) return;
          cursor = { recallTs: row.recallTs, msgId: BigInt(row.msgid) };
          if (row.recallTs > last.recallTs) {
            last.recallTs = row.recallTs;
            last.seen.clear();
          }
          if (last.seen.has(row.msgid)) continue;
          last.seen.add(row.msgid);
          try {
            const event = {
              kind: row.kind,
              conv: row.conv,
              msgId: row.msgid,
              senderUid: row.senderUid,
              revokeUid: row.revokeUid,
              origSeq: row.origSeq,
              recallTs: row.recallTs,
            };
            if (this.archive && row.kind !== 'dataline' && this.protects(row.kind, row.conv)) {
              const source = row.kind === 'group' ? this.session.groupMsgs : this.session.c2cMsgs;
              await this.archive.observeNative(await source.listByMsgIds([BigInt(row.msgid)]));
              await this.archive.observe(
                [],
                [
                  {
                    kind: row.kind,
                    conv: row.conv,
                    localId: row.msgid,
                    senderUid: row.senderUid,
                    revokeUid: row.revokeUid,
                    at: row.recallTs,
                  },
                ],
              );
            } else this.publishRecall(event);
          } catch (error) {
            logger.warn('anti-recall notify hook failed', {
              event: 'anti-recall-notify-failed',
              ...logErrorContext(error),
            });
          }
        }
        if (rows.length < 200) break;
      }
    } catch (error) {
      if (!this.monitorCurrent(reads)) return;
      logger.debug('anti-recall drain failed', {
        event: 'anti-recall-drain-failed',
        ...logErrorContext(error),
      });
    }
  }

  /**
   * True when this account's QQ is currently online — its `nt_msg.db` is held
   * by a QQ process (the only login probe left).
   */
  private isQqRunning(): boolean {
    try {
      return this.platform.isQqLoggedIn(this.session.context.uin);
    } catch {
      // If we can't tell, assume running — safer to defer a schema write than
      // to fight QQ for the lock.
      return true;
    }
  }

  /** 读取只借用账号连接；触发器写入路径仍负责 close 以释放写锁。 */
  private openDb(): AntiRecallDb {
    return new AntiRecallDb(this.platform.native.ntHelper, {
      dbPath: this.session.msgDbPath,
      key: this.session.context.dbKey,
      algo: algoFor(this.session.context, this.session.msgDbPath),
    });
  }
}
