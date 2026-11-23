import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  directoryUnreadKey,
  validReadPosition,
  messageReadCursor,
} from '@weq/service/client-preferences';
import type { AccountSession } from '@weq/account';
import type { GapFetchedMessage, AntiRecallService } from '@weq/service';
import type { NtHelperBinding } from '@weq/native';
import {
  fetchC2cHistoryRaw,
  fetchGroupHistoryRaw,
  extractPath,
  readReportWatermark,
} from '@weqbot/protocol';
import {
  buildClientReadNotify,
  wrapClientMessage,
  type ClientReadTarget,
} from '@weqbot/protocol/qq-sync';
import type { RecallJournalEntry } from './recall_journal';
import type { SyncProxyStatus } from './ipc';
import { qqSyncRequest, subscribeQqLive } from './runtime';
import { decodeLivePush, LiveMessages, type LivePushUpdates } from './live_messages';

type SentIdentity = Pick<
  GapFetchedMessage,
  'kind' | 'conv' | 'msgSeq' | 'msgRandom' | 'sendTime' | 'senderUid'
>;
type Task = { id: string; nextAt: number; attempts: number; error?: string } & (
  | { kind: 'message'; message: SentIdentity }
  | { kind: 'read'; target: ClientReadTarget }
);
export interface QqSyncSession {
  pid: number;
  key: string;
}
export interface AccountQqSyncOptions {
  root: string;
  path: string;
  session: AccountSession;
  nt: NtHelperBinding;
  enabled(): boolean;
  readEnabled(): boolean;
  antiRecall?: AntiRecallService;
  liveEnabled?(): boolean;
  onLiveMessages?(messages: GapFetchedMessage[]): void;
  onLiveUpdates?(updates: LivePushUpdates): void;
  onLiveClosed?(): void;
  allowLiveMessage?(message: GapFetchedMessage): boolean;
  current(): QqSyncSession | null;
}

/** 按账号保存工作身份，恢复时先查 QQ 是否已经接纳，再决定补投。 */
export class AccountQqSync {
  private tasks = new Map<string, Task>();
  private disposed = false;
  private running = false;
  private persistence: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private lastError = '';
  private completed = 0;
  private recallAck: string[] = [];
  private liveRecallRevision = 0;
  private recallReadRevision = 0;
  private recallReadAt = 0;
  private recallWake?: ReturnType<typeof setTimeout>;
  private flight?: Promise<void>;
  private recallActive = false;
  readonly liveMessages = new LiveMessages();
  private liveSubscription?: { generation: string; abort: AbortController };
  private liveReceivedAt = 0;
  private liveGroupChangedAt = 0;

  isLiveEnabled() {
    return this.options.liveEnabled?.() === true;
  }

  liveRows(kind: GapFetchedMessage['kind'], conv: string) {
    return this.liveMessages
      .forConversation(kind, conv, Date.now())
      .filter((row) => this.options.allowLiveMessage?.(row) !== false);
  }

  hasRecentLiveMessages(): boolean {
    return Boolean(
      this.liveSubscription &&
        this.options.liveEnabled?.() &&
        Date.now() - this.liveReceivedAt < 2000,
    );
  }

  hasRecentGroupUpdates(): boolean {
    return (
      this.isLiveEnabled() &&
      Boolean(this.liveSubscription) &&
      Date.now() - this.liveGroupChangedAt < 2000
    );
  }

  refreshLive() {
    if (!this.options.liveEnabled?.()) this.stopLive();
    void this.run();
  }

  private stopLive() {
    const old = this.liveSubscription;
    this.liveSubscription = undefined;
    this.liveReceivedAt = 0;
    this.liveGroupChangedAt = 0;
    clearTimeout(this.recallWake);
    this.recallWake = undefined;
    old?.abort.abort();
    if (old) this.options.onLiveClosed?.();
  }

  private startLive(uin: string, generation: string, valid: () => boolean) {
    if (!this.options.liveEnabled?.() || !this.options.onLiveMessages) return;
    if (this.liveSubscription?.generation === generation) return;
    this.stopLive();
    const subscription = { generation, abort: new AbortController() };
    this.liveSubscription = subscription;
    this.recallReadAt = 0;
    const selfUid = this.options.session.selfUid ?? '';
    void subscribeQqLive(this.options.root, uin, generation, subscription.abort.signal, (body) => {
      if (!valid() || !this.options.liveEnabled?.() || this.liveSubscription !== subscription)
        return;
      const now = Date.now();
      if (this.recallActive) this.liveRecallRevision++;
      const { rows: messages, updates } = decodeLivePush(body, selfUid, uin, now);
      const decoded = messages.filter((row) => this.options.allowLiveMessage?.(row) !== false);
      const rows = this.liveMessages.accept(decoded, now);
      if (rows.length || updates.reads.length || updates.reactions.length || updates.recalled)
        this.liveReceivedAt = now;
      if (updates.groups.length) this.liveGroupChangedAt = now;
      if (updates.recalled && this.recallActive && !this.recallWake) {
        this.recallWake = setTimeout(() => {
          this.recallWake = undefined;
          const flight = this.flight;
          if (flight) {
            void flight.then(() => {
              if (this.liveSubscription === subscription) return this.run();
            });
          } else if (this.liveSubscription === subscription) void this.run();
        }, 120).unref();
      }
      if (rows.length) this.options.onLiveMessages?.(rows);
      if (
        updates.reads.length ||
        updates.groups.length ||
        updates.reactions.length ||
        updates.recalled
      )
        this.options.onLiveUpdates?.(updates);
    })
      .catch(() => undefined)
      .finally(() => {
        if (this.liveSubscription === subscription) this.stopLive();
      });
  }
  constructor(private readonly options: AccountQqSyncOptions) {
    try {
      const saved = JSON.parse(readFileSync(options.path, 'utf8'));
      if (saved.uin === String(options.session.context.uin) && Array.isArray(saved.tasks))
        this.tasks = new Map(
          saved.tasks
            .slice(0, 512)
            .filter(
              (task: Task) =>
                task &&
                typeof task.id === 'string' &&
                ((task.kind === 'message' && task.message) ||
                  (task.kind === 'read' && task.target)),
            )
            .map((task: Task) => [task.id, task]),
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.lastError = '同步任务恢复失败';
    }
    this.timer = setInterval(() => void this.run(), 2000);
    this.timer.unref();
    void this.run();
  }
  status() {
    return { pending: this.tasks.size, completed: this.completed, error: this.lastError };
  }
  sent(message: GapFetchedMessage) {
    if (
      !this.options.enabled() ||
      this.disposed ||
      !message.msgRandom ||
      message.senderUid !== this.options.session.selfUid
    )
      return;
    const { kind, conv, msgSeq, msgRandom, sendTime, senderUid } = message;
    const id = `message:${kind}:${conv}:${msgSeq}:${msgRandom}`;
    if (this.tasks.has(id)) return;
    this.enqueue({
      id,
      kind: 'message',
      message: { kind, conv, msgSeq, msgRandom, sendTime, senderUid },
      attempts: 0,
      nextAt: Date.now() + 700,
    });
  }
  read(target: ClientReadTarget) {
    if (!this.options.enabled() || !this.options.readEnabled() || this.disposed) return;
    const id = `read:${target.kind}:${target.kind === 'group' ? target.groupUin : target.targetUid}`;
    const prior = this.tasks.get(id);
    if (prior?.kind === 'read' && readReportWatermark(prior.target) >= readReportWatermark(target))
      return;
    this.enqueue({ id, kind: 'read', target, attempts: 0, nextAt: Date.now() });
  }
  refresh() {
    void this.run();
  }
  private async currentRead(target: ClientReadTarget): Promise<boolean> {
    if (target.kind === 'official') {
      const state = JSON.parse(
        readFileSync(join(dirname(this.options.path), 'client-state.json'), 'utf8'),
      );
      const reads = state.records?.reads ?? {};
      const key = `official:${target.targetUid}`;
      const position = reads[key];
      return (
        validReadPosition(position) &&
        position.startsWith('0:') &&
        !reads[directoryUnreadKey(key)] &&
        Number(messageReadCursor(position).sendTime) === target.timestamp
      );
    }
    const snapshot = await this.options.session.unreadInfo.getUnreadInfo(
      target.kind === 'group' ? 2 : 1,
      target.kind === 'group' ? String(target.groupUin) : target.targetUid,
    );
    return (
      !snapshot?.markUnread &&
      BigInt(snapshot?.msgSeq ?? 0) <= BigInt(target.sequence) &&
      BigInt(snapshot?.localReadSeq ?? '0') <= BigInt(target.sequence)
    );
  }
  private enqueue(task: Task) {
    if (this.tasks.size >= 512 && !this.tasks.has(task.id)) {
      this.lastError = 'QQ 同步待处理任务已达上限';
      return;
    }
    this.tasks.set(task.id, task);
    void this.save()
      .then(() => this.run())
      .catch(() => {
        this.lastError = 'QQ 同步任务保存失败';
      });
  }
  private save() {
    const data = JSON.stringify({
      uin: String(this.options.session.context.uin),
      tasks: [...this.tasks.values()],
    });
    const path = this.options.path;
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, data, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      });
    return this.persistence;
  }
  async dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.stopLive();
    await this.flight;
    await this.persistence.catch(() => undefined);
    const current = this.options.current();
    if (current && this.options.antiRecall) {
      const generation = createHash('sha256').update(`${current.pid}:${current.key}`).digest('hex');
      await qqSyncRequest(this.options.root, {
        op: 'recall-policy',
        uin: String(this.options.session.context.uin),
        generation,
        value: { owner: this.options.path, enabled: false, block: false, all: false, targets: [] },
      }).catch(() => undefined);
    }
  }

  private async exists(message: SentIdentity): Promise<boolean> {
    const session = this.options.session;
    const sequence = BigInt(message.msgSeq);
    const rows =
      message.kind === 'group'
        ? await session.groupMsgs.listBySeqsInPartition(message.conv, [sequence])
        : await session.c2cMsgs.listBySeqsInPartition(
            session.uidMap.sortNoByUid(message.conv) === undefined
              ? { uid: message.conv }
              : { sortNo: session.uidMap.sortNoByUid(message.conv)! },
            [sequence],
          );
    return rows.some(
      (row) => String(row.msgRandom) === message.msgRandom && row.senderUid === message.senderUid,
    );
  }
  private async messageBody(message: SentIdentity, pid: number) {
    const sequence = Number(message.msgSeq);
    const response =
      message.kind === 'group'
        ? await fetchGroupHistoryRaw(this.options.nt, pid, {
            groupUin: Number(message.conv),
            startSeq: sequence,
            endSeq: sequence,
          })
        : await fetchC2cHistoryRaw(this.options.nt, pid, {
            friendUid: message.conv,
            startSeq: sequence,
            endSeq: sequence,
          });
    if (
      String(message.kind === 'group' ? response.peer.groupUin : response.peer.friendUid) !==
      message.conv
    )
      throw new Error('服务器历史会话不匹配');
    const index = response.messages.findIndex((row) => {
      const routing = row.responseHead as { fromUid?: string } | undefined;
      const head = row.contentHead as { msgId?: number } | undefined;
      return routing?.fromUid === message.senderUid && String(head?.msgId) === message.msgRandom;
    });
    if (index < 0) throw new Error('等待服务器确认原始消息');
    const bytes = extractPath(
      response.rawResponse,
      message.kind === 'group' ? [{ tag: 3 }, { tag: 6, index }] : [{ tag: 7, index }],
    );
    if (!bytes) throw new Error('服务器原始消息不完整');
    return wrapClientMessage(bytes);
  }
  private run(): Promise<void> {
    this.flight ??= this.runOnce().finally(() => {
      this.flight = undefined;
    });
    return this.flight;
  }
  private generationFor(current: QqSyncSession) {
    return createHash('sha256').update(`${current.pid}:${current.key}`).digest('hex');
  }
  private async runOnce() {
    const protection = this.options.antiRecall?.protection();
    if (!this.options.liveEnabled?.()) this.stopLive();
    if (
      this.disposed ||
      this.running ||
      (!this.options.enabled() &&
        !protection?.enabled &&
        !this.recallActive &&
        !this.options.liveEnabled?.())
    )
      return;
    const current = this.options.current();
    if (!current) {
      this.stopLive();
      this.options.antiRecall?.setProxyState(false);
      return;
    }
    if (
      this.liveSubscription &&
      !this.options.enabled() &&
      !protection?.enabled &&
      !this.recallActive &&
      this.liveSubscription.generation === this.generationFor(current)
    )
      return;
    this.running = true;
    const uin = String(this.options.session.context.uin);
    const generation = this.generationFor(current);
    const valid = () => {
      const now = this.options.current();
      return (
        !this.disposed &&
        (this.options.enabled() ||
          this.options.antiRecall?.protection().enabled ||
          this.recallActive ||
          this.options.liveEnabled?.() === true) &&
        now?.pid === current.pid &&
        now.key === current.key
      );
    };
    try {
      await qqSyncRequest(this.options.root, {
        op: 'credential',
        value: { uin, key: current.key, generation, selfUid: this.options.session.selfUid },
      });
      if (valid()) this.startLive(uin, generation, valid);
      if (
        this.options.antiRecall &&
        valid() &&
        (protection?.enabled || this.recallActive || this.options.enabled())
      ) {
        const status = await qqSyncRequest<SyncProxyStatus>(this.options.root, { op: 'status' });
        if ((status.protocolVersion ?? 1) < 2)
          throw new Error('请应用开发更新以启用新版防撤回代理');
        const active = this.options.antiRecall.protection();
        await qqSyncRequest(this.options.root, {
          op: 'recall-policy',
          uin,
          generation,
          value: {
            owner: this.options.path,
            enabled: active.enabled,
            block: active.method === 'proxy',
            all: active.mode === 'all',
            targets: active.targets,
          },
        });
        const wasActive = this.recallActive;
        this.recallActive = active.enabled;
        if (
          this.recallAck.length ||
          wasActive !== active.enabled ||
          (active.enabled &&
            (!this.liveSubscription ||
              this.recallReadRevision !== this.liveRecallRevision ||
              Date.now() - this.recallReadAt >= 6000))
        ) {
          const revision = this.liveRecallRevision;
          const entries = await qqSyncRequest<RecallJournalEntry[]>(this.options.root, {
            op: 'recall-events',
            uin,
            generation,
            ack: this.recallAck,
          });
          this.recallAck = [];
          for (const entry of entries) {
            if (!valid()) break;
            await this.options.antiRecall.archive?.observePush(
              entry.events,
              this.options.session.selfUid!,
              entry.at,
            );
            this.recallAck.push(entry.id);
          }
          this.recallReadRevision = revision;
          this.recallReadAt = Date.now();
        }
        this.options.antiRecall.setProxyState(status.accounts.includes(uin), status.recallError);
      }
      for (const task of this.tasks.values()) {
        if (!this.options.enabled()) break;
        if (!valid()) break;
        if (task.kind === 'read' && !this.options.readEnabled()) {
          this.tasks.delete(task.id);
          await this.save();
          continue;
        }
        if (task.nextAt > Date.now()) continue;
        try {
          if (task.kind === 'message' && (await this.exists(task.message))) {
            this.tasks.delete(task.id);
            this.completed++;
            await this.save();
            continue;
          }
          if (task.kind === 'read' && !(await this.currentRead(task.target))) {
            if (this.tasks.get(task.id) === task) this.tasks.delete(task.id);
            await this.save();
            continue;
          }
          const body =
            task.kind === 'message'
              ? await this.messageBody(task.message, current.pid)
              : buildClientReadNotify({ uin, uid: this.options.session.selfUid! }, task.target);
          if (
            !valid() ||
            this.tasks.get(task.id) !== task ||
            (task.kind === 'read' && !this.options.readEnabled())
          )
            continue;
          const identity =
            task.kind === 'read' ? `${task.id}:${readReportWatermark(task.target)}` : task.id;
          await qqSyncRequest(this.options.root, {
            op: 'push',
            uin,
            generation,
            identity,
            body: body.toString('base64'),
          });
          if (task.kind === 'message') {
            await new Promise((resolve) => setTimeout(resolve, 600));
            if (!valid()) break;
            if (!(await this.exists(task.message))) throw new Error('等待 QQ 接纳消息');
          }
          if (this.tasks.get(task.id) === task) {
            this.tasks.delete(task.id);
            this.completed++;
          }
          this.lastError = '';
        } catch (error) {
          task.attempts++;
          task.nextAt = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(task.attempts, 6));
          task.error = (error as Error).message;
          this.lastError = task.error;
        }
        await this.save();
      }
    } catch (error) {
      this.lastError = (error as Error).message;
      this.options.antiRecall?.setProxyState(false, this.lastError);
    } finally {
      this.running = false;
    }
  }
}
