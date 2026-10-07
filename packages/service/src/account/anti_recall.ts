/**
 * AntiRecallService — anti-recall feature bound to the current account.
 *
 * Ties four things together:
 *   • persisted config (per account): master switch + the set of conversations
 *     the user chose to protect + the per-conversation recall-notification set.
 *     Stored as one JSON file, modeled on {@link DeletedMsgStore} (load on
 *     construct, persist on mutate, silent on I/O error).
 *   • the SQL-trigger installer {@link AntiRecallDb} (in @weq/db) that actually
 *     writes/drops the `BEFORE UPDATE … RAISE(IGNORE)` triggers on nt_msg.db.
 *   • a `qqRunning` hint alongside every write: install/uninstall works whether
 *     or not QQ is open (each trigger DDL is a short, lock-releasing write), but
 *     QQ may keep serving from its already-open connection's cached schema, so a
 *     freshly (un)installed trigger can take until QQ's next restart to actually
 *     (stop) firing. The renderer surfaces `qqRunning` to warn about exactly that.
 *   • a background monitor (a {@link DbWatchService} on nt_msg.db) that drains the
 *     `weq_recall_log` table the trigger writes and raises the injected
 *     `onRecall` hook for conversations whose notification switch is on. The
 *     monitor baselines on start / whenever protection is (re)enabled, so records
 *     that pre-date this run never notify (启动时老记录不通知).
 *
 * The renderer drives it through the anti_recall tRPC router:
 *   getStatus        → { …config, installed, qqRunning }  (installed = live triggers)
 *   setEnabled       → flip master switch, reconcile triggers
 *   setMode          → 'selected' | 'all' (永久全选), reconcile triggers
 *   setTargets       → replace protected-conversation set, reconcile triggers
 *   setNotify        → notification master switch + per-conversation set
 *   listRecalls      → recorded recalls of one conversation (撤回记录面板)
 *   listRecallConversations → per-conversation summary of recorded recalls (目录)
 *
 * Settings writes are **optimistic**: they persist config, kick the (potentially
 * slow, SQLCipher) trigger reconcile off in the background, and return the
 * desired state immediately so the UI never blocks. A later `getStatus` reads the
 * live trigger set as the source of truth.
 */

import {
  AntiRecallDb,
  expectedAntiRecallTriggers,
  type AntiRecallTarget,
  type AntiRecallTriggerInfo,
  type RecallConvSummary,
  type RecallLogRow,
} from '@weq/db';
import { type AccountSession, algoFor } from '@weq/account';
import type { Platform } from '@weq/platform';
import { JsonStore } from '../common/json_store';
import { DbWatchService, type DbWatchHandle, type DbWatchTask } from './db_watch';
import { getLogger, logErrorContext } from '../common/logger';

const logger = getLogger().child({ scope: 'anti-recall' });

/** Persisted anti-recall config for one account. */
export interface AntiRecallConfig {
  /** Master switch. When false, no triggers are installed regardless of targets/mode. */
  enabled: boolean;
  /**
   * `'selected'` (default) — only `targets` are protected.
   * `'all'` — every conversation is protected (永久全选，不做会话筛选);
   * `targets` is ignored while this mode is active, but kept in the config so
   * switching back to `'selected'` restores the prior selection.
   */
  mode: 'selected' | 'all';
  /** Conversations the user chose to protect (used when `mode === 'selected'`). */
  targets: AntiRecallTarget[];
  /** Master switch for recall notifications (system-native popups). */
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
  /** Triggers actually present in the DB right now (source of truth for state). */
  installed: AntiRecallTriggerInfo[];
  /** True while QQ is running — installs are deferred / the UI warns to restart. */
  qqRunning: boolean;
}

/** One intercepted recall handed to the injected notifier. */
export interface RecallNotifyEvent {
  kind: 'c2c' | 'group' | 'dataline';
  /** Conversation key: peer uid (c2c/dataline) or group code (group). */
  conv: string;
  senderUid: string;
  revokeUid: string;
  origSeq: string;
  recallTs: number;
}

export interface AntiRecallOptions {
  /**
   * Raised for every newly-recorded recall in a conversation whose notification
   * switch is on. Implemented in the Electron main process (native notification
   * + click-to-jump); the service layer stays platform-free.
   */
  onRecall?: (event: RecallNotifyEvent) => void;
}

const DEFAULT_CONFIG: AntiRecallConfig = {
  enabled: false,
  mode: 'selected',
  targets: [],
  notifyEnabled: false,
  notifyTargets: [],
};

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
  /**
   * 撤回记录的读取游标（`weq_recall_log` 的最大 msgid）。null = 尚未建立基线，
   * 下次 drain 只记录当前最大值、不通知 —— 保证启动 / 刚开启保护时不会把历史记录
   * 当新撤回弹出来。
   */
  private recallCursor: number | null = null;

  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
    storePath: string,
    private readonly opts: AntiRecallOptions = {},
  ) {
    this.configStore = new JsonStore(storePath, () => ({ ...DEFAULT_CONFIG }), {
      normalize: (raw) => {
        const parsed = (raw ?? {}) as Partial<AntiRecallConfig>;
        return {
          enabled: parsed.enabled === true,
          mode: parsed.mode === 'all' ? 'all' : 'selected',
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
  }

  /** 当前配置（内存态）。 */
  private get config(): AntiRecallConfig {
    return this.configStore.data;
  }

  private set config(next: AntiRecallConfig) {
    this.configStore.data = next;
  }

  /** Current config + live trigger state + whether QQ is running. */
  async getStatus(): Promise<AntiRecallStatus> {
    const db = this.openDb();
    try {
      const installed = await db.status();
      return {
        ...this.config,
        installed,
        qqRunning: this.isQqRunning(),
      };
    } finally {
      db.close();
    }
  }

  /**
   * The recorded recalls for one conversation, newest-first — read straight from
   * the `weq_recall_log` table the trigger writes to. Empty when the feature was
   * never enabled (the table doesn't exist yet — {@link AntiRecallDb.listRecalls}
   * handles that). Drives the 「撤回记录」面板.
   */
  async listRecalls(kind: 'c2c' | 'group', conv: string): Promise<RecallLogRow[]> {
    const db = this.openDb();
    try {
      const rows = await db.listRecalls(kind, conv);
      if (kind !== 'c2c') return rows;
      // 数据线（我的手机 / 我的电脑）在消息库里是**独立一张表**、触发器也单独一张，
      // 但会话 key 与私聊同为 40021 的 uid。面板 / 消息标记只知道 'c2c' 这一档，
      // 所以这里把 dataline 的记录一起取回 —— 同一个 conv 不会同时出现在两张表里，
      // 合并无副作用，却让数据线的撤回记录也能看见。
      const dataline = await db.listRecalls('dataline', conv);
      if (dataline.length === 0) return rows;
      return [...rows, ...dataline].sort((a, b) => b.recallTs - a.recallTs);
    } finally {
      db.close();
    }
  }

  /**
   * Per-conversation summary of the recorded recalls (count + last time),
   * most recently active first — the directory behind the 「撤回记录」集成页.
   * Rows without a usable conversation key are dropped.
   */
  async listRecallConversations(): Promise<RecallConvSummary[]> {
    const db = this.openDb();
    try {
      const summaries = await db.recallSummaries();
      return summaries.filter((s) => s.conv !== '');
    } finally {
      db.close();
    }
  }

  /**
   * A `msgId → recall info` map for one conversation, so a message page can be
   * tagged in a single DB read instead of one lookup per message. Consumed by
   * {@link MsgService} to attach `recall` to each rendered message.
   */
  async getRecallMap(
    kind: 'c2c' | 'group',
    conv: string,
  ): Promise<Map<string, { revokeUid: string; senderUid: string; recallTs: number }>> {
    const rows = await this.listRecalls(kind, conv);
    const map = new Map<string, { revokeUid: string; senderUid: string; recallTs: number }>();
    for (const r of rows) {
      map.set(r.msgid, { revokeUid: r.revokeUid, senderUid: r.senderUid, recallTs: r.recallTs });
    }
    return map;
  }

  /** Flip the master switch, then reconcile triggers to match. Persists. */
  async setEnabled(enabled: boolean): Promise<AntiRecallStatus> {
    this.config = { ...this.config, enabled };
    this.persist();
    // (重新)开启保护时重建通知基线：历史记录不该在新一轮里弹出来。
    this.resetRecallBaseline();
    this.reconcileInBackground();
    return this.optimisticStatus();
  }

  /**
   * Switch between protecting only `targets` (`'selected'`) and protecting
   * every conversation with no session filter (`'all'`, 永久全选). Persists.
   */
  async setMode(mode: 'selected' | 'all'): Promise<AntiRecallStatus> {
    this.config = { ...this.config, mode };
    this.persist();
    this.reconcileInBackground();
    return this.optimisticStatus();
  }

  /** Replace the protected-conversation set, then reconcile. Persists. */
  async setTargets(targets: AntiRecallTarget[]): Promise<AntiRecallStatus> {
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
    this.persist();
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
    this.persist();
    return this.optimisticStatus();
  }

  /**
   * Mount the recall monitor (nt_msg.db change watch → drain `weq_recall_log`).
   * Idempotent. Independent of whether protection is currently enabled; the drain
   * itself is the thing that gates on config.
   */
  startMonitor(): void {
    if (this.monitorHandle) return;
    this.monitor = new DbWatchService({ intervalMs: 1_000 });
    const task: DbWatchTask = {
      dbPath: this.session.msgDbPath,
      onDbFileChangeHook: () => this.drainRecalls(),
    };
    this.monitorHandle = this.monitor.mount(task);
    this.resetRecallBaseline();
  }

  /** Stop the recall monitor. Idempotent. */
  stopMonitor(): void {
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
    const db = this.openDb();
    try {
      const allConversations = this.config.enabled && this.config.mode === 'all';
      const active = this.config.enabled ? this.config.targets : [];
      await db.reconcile(active, allConversations);
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
    void this.applyTriggers().catch((error) => {
      logger.warn('anti-recall reconcile failed', {
        event: 'anti-recall-reconcile-failed',
        ...logErrorContext(error),
      });
    });
  }

  /** Status snapshot built from the desired config (no DB read). */
  private optimisticStatus(): AntiRecallStatus {
    const allConversations = this.config.enabled && this.config.mode === 'all';
    const active = this.config.enabled ? this.config.targets : [];
    return {
      ...this.config,
      installed: expectedAntiRecallTriggers(allConversations, active),
      qqRunning: this.isQqRunning(),
    };
  }

  private shouldNotify(row: RecallLogRow): boolean {
    if (!this.config.notifyEnabled) return false;
    return this.config.notifyTargets.includes(notifyKey(row.kind, row.conv));
  }

  /**
   * Baseline the recall cursor: the next drain records the current max msgid and
   * raises nothing. Called on start and whenever protection is (re)enabled.
   */
  private resetRecallBaseline(): void {
    this.recallCursor = null;
    void this.initRecallBaseline();
  }

  private async initRecallBaseline(): Promise<void> {
    try {
      const db = this.openDb();
      try {
        this.recallCursor = await db.latestRecallCursor();
      } finally {
        db.close();
      }
    } catch (error) {
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
  private async drainRecalls(): Promise<void> {
    if (!this.config.enabled && !this.config.notifyEnabled) return;
    const db = this.openDb();
    try {
      if (this.recallCursor === null) {
        this.recallCursor = await db.latestRecallCursor();
        return;
      }
      let cursor = this.recallCursor;
      for (let page = 0; page < 20; page++) {
        const rows = await db.listRecallsAfter(cursor, 200);
        if (rows.length === 0) break;
        for (const row of rows) {
          cursor = Math.max(cursor, Number(row.msgid) || 0);
          if (!this.shouldNotify(row)) continue;
          try {
            this.opts.onRecall?.({
              kind: row.kind,
              conv: row.conv,
              senderUid: row.senderUid,
              revokeUid: row.revokeUid,
              origSeq: row.origSeq,
              recallTs: row.recallTs,
            });
          } catch (error) {
            logger.warn('anti-recall notify hook failed', {
              event: 'anti-recall-notify-failed',
              ...logErrorContext(error),
            });
          }
        }
        if (rows.length < 200) break;
      }
      this.recallCursor = cursor;
    } catch (error) {
      logger.debug('anti-recall drain failed', {
        event: 'anti-recall-drain-failed',
        ...logErrorContext(error),
      });
    } finally {
      db.close();
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

  private openDb(): AntiRecallDb {
    return new AntiRecallDb(this.platform.native.ntHelper, {
      dbPath: this.session.msgDbPath,
      key: this.session.context.dbKey,
      algo: algoFor(this.session.context, this.session.msgDbPath),
    });
  }

  private persist(): void {
    this.configStore.save();
  }
}
