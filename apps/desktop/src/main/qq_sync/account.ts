import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AccountSession } from '@weq/account';
import type { GapFetchedMessage } from '@weq/service';
import type { NtHelperBinding } from '@weq/native';
import { fetchC2cHistoryRaw, fetchGroupHistoryRaw, extractPath } from '@weqbot/protocol';
import {
  buildClientReadNotify,
  wrapClientMessage,
  type ClientReadTarget,
} from '@weqbot/protocol/qq-sync';
import { qqSyncRequest } from './runtime';

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
    if (prior?.kind === 'read' && prior.target.sequence >= target.sequence) return;
    this.enqueue({ id, kind: 'read', target, attempts: 0, nextAt: Date.now() });
  }
  refresh() {
    void this.run();
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
    await this.persistence.catch(() => undefined);
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
      (row) =>
        String(row.msgRandom) === message.msgRandom &&
        String(row.sendTime) === message.sendTime &&
        row.senderUid === message.senderUid,
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
      const head = row.contentHead as { msgId?: number; timestamp?: number } | undefined;
      return (
        routing?.fromUid === message.senderUid &&
        String(head?.msgId) === message.msgRandom &&
        String(head?.timestamp) === message.sendTime
      );
    });
    if (index < 0) throw new Error('等待服务器确认原始消息');
    const bytes = extractPath(
      response.rawResponse,
      message.kind === 'group' ? [{ tag: 3 }, { tag: 6, index }] : [{ tag: 7, index }],
    );
    if (!bytes) throw new Error('服务器原始消息不完整');
    return wrapClientMessage(bytes);
  }
  private async run() {
    if (this.disposed || this.running || !this.options.enabled()) return;
    const current = this.options.current();
    if (!current) return;
    this.running = true;
    const uin = String(this.options.session.context.uin);
    const generation = createHash('sha256').update(`${current.pid}:${current.key}`).digest('hex');
    const valid = () => {
      const now = this.options.current();
      return (
        !this.disposed &&
        this.options.enabled() &&
        now?.pid === current.pid &&
        now.key === current.key
      );
    };
    try {
      await qqSyncRequest(this.options.root, {
        op: 'credential',
        value: { uin, key: current.key, generation },
      });
      for (const task of this.tasks.values()) {
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
          if (task.kind === 'read') {
            const target = task.target;
            const snapshot = await this.options.session.unreadInfo.getUnreadInfo(
              target.kind === 'group' ? 2 : 1,
              target.kind === 'group' ? String(target.groupUin) : target.targetUid,
            );
            if (
              snapshot?.markUnread ||
              BigInt(snapshot?.msgSeq ?? 0) > BigInt(target.sequence) ||
              BigInt(snapshot?.localReadSeq ?? '0') > BigInt(target.sequence)
            ) {
              if (this.tasks.get(task.id) === task) this.tasks.delete(task.id);
              await this.save();
              continue;
            }
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
          const identity = task.kind === 'read' ? `${task.id}:${task.target.sequence}` : task.id;
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
    } finally {
      this.running = false;
    }
  }
}
