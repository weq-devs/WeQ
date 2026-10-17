import { EventEmitter } from 'node:events';
import type { NtHelperBinding } from '@weq/native';
import WebSocket from 'ws';
import { MailAuth } from './auth';
import { MailAttachmentRegistry } from './attachments';
import { decodeMailSocketFrame, MailNoticeCursor } from './notifications';
import {
  MailFailure,
  type MailAction,
  type MailAddress,
  type MailComposeInput,
  type MailDetail,
  type MailEvent,
  type MailFolder,
  type MailListInput,
  type MailPage,
  type MailStatus,
} from './types';
import {
  MAIL_PAGE_SIZE,
  composeMailForm,
  count,
  items,
  mailAddress,
  mailFolders,
  mailSummary,
  object,
  text,
} from './wire';

export class QQMailService {
  readonly events = new EventEmitter<{ change: [MailEvent] }>();
  readonly attachments = new MailAttachmentRegistry();
  private auth: MailAuth;
  private readonly makeAuth: () => MailAuth;
  private state: MailStatus = {
    state: 'disconnected',
    unread: 0,
    notifications: false,
    lastSync: null,
    error: null,
  };
  private closed = false;
  private socket: WebSocket | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private cursor = new MailNoticeCursor();
  private sending = false;
  private readonly totals = new Map<string, number>();

  constructor(
    nt: Pick<NtHelperBinding, 'probePtLoginPort'>,
    readonly uin: string,
    onlinePid: () => number | null,
    options: { authFactory?: () => MailAuth } = {},
  ) {
    this.makeAuth = options.authFactory ?? (() => new MailAuth(nt, uin, onlinePid));
    this.auth = this.makeAuth();
  }

  status(): MailStatus {
    return { ...this.state };
  }

  private update(patch: Partial<MailStatus>): void {
    if (this.closed) return;
    this.state = { ...this.state, ...patch };
    this.events.emit('change', { type: 'status', status: this.status() });
  }

  private async scoped<T>(run: (auth: MailAuth) => Promise<T>, writeResult = false): Promise<T> {
    if (this.closed) throw new MailFailure('auth', '邮箱会话已关闭。');
    const auth = this.auth;
    const result = await run(auth);
    if (this.closed || this.auth !== auth)
      throw new MailFailure(
        writeResult ? 'unknown-send' : 'auth',
        writeResult
          ? '提交期间账号状态已变化，请先核对邮箱结果，不要直接重试。'
          : '邮箱账号状态已变化，请重新打开。',
      );
    return result;
  }

  async connect(signal?: AbortSignal): Promise<MailStatus> {
    if (this.auth.ready) return this.status();
    this.update({ state: 'connecting', error: null });
    const auth = this.auth;
    try {
      await this.scoped((current) => current.connect(signal));
      this.update({ state: 'ready', error: null });
      try {
        await this.syncNotice(true, signal);
      } catch {
        if (this.auth === auth) this.update({ error: '邮箱已连接，提醒同步暂不可用。' });
      }
      return this.status();
    } catch (error) {
      if (this.auth === auth)
        this.update({
          state: 'error',
          error: error instanceof MailFailure ? error.message : '邮箱连接失败，请重试。',
        });
      throw error instanceof MailFailure
        ? error
        : new MailFailure('auth', '邮箱连接失败，请重试。');
    }
  }

  async folders(signal?: AbortSignal): Promise<MailFolder[]> {
    return this.scoped(async (auth) => {
      const body = await auth.cgi('/list/folderlist', {}, { signal });
      return mailFolders(body.list);
    });
  }

  async list(input: MailListInput, signal?: AbortSignal): Promise<MailPage> {
    const size = Math.min(100, Math.max(1, input.pageSize ?? MAIL_PAGE_SIZE));
    const func =
      input.folderId === 2
        ? 2
        : input.folderId === 4000
          ? 7
          : input.folderId > 4000 && input.folderId <= 4064
            ? 3
            : input.folderId === 2000
              ? 6
              : 1;
    const body = await this.scoped((auth) =>
      auth.cgi(
        '/list/maillist',
        {
          func,
          dir: input.folderId,
          dirid: input.folderId,
          page_now: input.page,
          page_size: size,
          sort_type: 1,
          sort_direction: 1,
          only_unread: input.unreadOnly || undefined,
          enable_topmail: true,
        },
        { signal },
      ),
    );
    const rows = items(body.list)
      .map(mailSummary)
      .filter((entry) => entry.id);
    const key = `${input.folderId}:${Boolean(input.unreadOnly)}`;
    if (body.total_num !== undefined)
      this.totals.set(key, count(input.unreadOnly ? body.unread_num : body.total_num));
    const total = this.totals.get(key) ?? rows.length;
    this.update({ state: 'ready', error: null, lastSync: Date.now() });
    return {
      items: rows,
      page: input.page,
      total,
      unread: count(body.unread_num),
      hasMore:
        body.total_num === undefined && !this.totals.has(key)
          ? rows.length >= size
          : (input.page + 1) * size < total,
    };
  }

  async read(id: string, signal?: AbortSignal): Promise<MailDetail> {
    const group = id.startsWith('@');
    if (id.startsWith('C') && !id.startsWith('CAD'))
      throw new MailFailure('business', '请展开会话邮件后选择具体邮件。');
    const body = await this.scoped((auth) =>
      auth.cgi(
        group ? '/groupmail/readmail' : '/read/readmail',
        { mailid: id, func: group ? 0 : 1 },
        { signal },
      ),
    );
    const entry = object(body.item);
    if (text(entry.ret) !== '0')
      throw new MailFailure('business', '邮件已删除、不可访问或需要额外验证。', text(entry.ret));
    const summary = mailSummary(entry);
    const detail: MailDetail = {
      ...summary,
      html: text(entry.content),
      replyTo: entry.replyto ? mailAddress(entry.replyto) : null,
      attachments: this.attachments.fromMessage(entry, id),
    };
    this.events.emit('change', { type: 'changed' });
    return detail;
  }

  async action(ids: string[], action: MailAction, signal?: AbortSignal): Promise<void> {
    const funcs: Record<MailAction, number> = { read: 4, unread: 5, star: 6, unstar: 7, trash: 1 };
    await this.scoped(async (auth) => {
      await auth.cgi('/mgr/mailmgr', { mailid: ids, func: funcs[action] }, { signal, write: true });
    });
    this.events.emit('change', { type: 'changed' });
  }

  async send(
    input: MailComposeInput,
    draft = false,
    signal?: AbortSignal,
  ): Promise<{ id: string; messageId: string }> {
    if (this.sending) throw new MailFailure('business', '当前邮件正在提交，请等待结果。');
    const sender: MailAddress = { email: `${this.uin}@qq.com`, name: '' };
    const params = composeMailForm(input, sender, draft);
    const attachments = this.attachments.sendParams(input.attachments);
    params.attachment = attachments.normal;
    params.big_attachment = attachments.big;
    this.sending = true;
    try {
      const body = await this.scoped(
        (auth) => auth.cgi('/send/sendmail', params, { signal, write: true }),
        true,
      );
      const id = text(body.mailid),
        messageId = text(body.messageid);
      if (!id && !messageId)
        throw new MailFailure(
          'unknown-send',
          '邮箱未返回提交结果，请先检查草稿箱或已发送，不要直接重试。',
        );
      this.events.emit('change', { type: 'changed' });
      return { id, messageId };
    } catch (error) {
      if (!(error instanceof MailFailure) || error.kind === 'network')
        throw new MailFailure(
          'unknown-send',
          draft
            ? '草稿保存结果未知，请先刷新草稿箱确认。'
            : '发送结果未知，请先检查已发送邮件，不要直接重发。',
        );
      throw error;
    } finally {
      this.sending = false;
    }
  }

  async setNotifications(enabled: boolean): Promise<MailStatus> {
    this.update({ notifications: enabled });
    if (!enabled) this.stopNotifications();
    else {
      await this.connect();
      await this.syncNotice(true);
      await this.openSocket();
    }
    return this.status();
  }

  private async syncNotice(prime: boolean, signal?: AbortSignal): Promise<void> {
    const body = await this.scoped((auth) => auth.notificationQuery(signal));
    const notices = items(body.newmaillist).map((value) => {
      const entry = object(value);
      const sender = object(entry.senderinfo ?? entry.sender_info);
      return {
        id: text(entry.mailid),
        subject: text(entry.subject),
        sender: text(sender.sendername ?? sender.sender_name ?? entry.sendername),
        folderId: count(entry.mailboxid ?? entry.mailbox_id) || 1,
      };
    });
    if (prime) this.cursor.prime(notices.map((entry) => entry.id));
    else
      for (const notice of notices)
        if (this.cursor.accept(notice.id)) this.events.emit('change', { type: 'new-mail', notice });
    this.update({ unread: count(body.unread), lastSync: Date.now() });
    if (this.state.notifications) {
      if (this.pollTimer) clearTimeout(this.pollTimer);
      const seconds = Math.min(3600, Math.max(60, count(body.next_sync_time_interval_sec) || 900));
      this.pollTimer = setTimeout(() => {
        this.pollTimer = null;
        void this.syncNotice(false).catch(() => this.scheduleNoticeRecovery());
      }, seconds * 1000);
      this.pollTimer.unref();
    }
  }

  private scheduleNoticeRecovery(): void {
    if (this.closed || !this.state.notifications || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.syncNotice(false)
        .then(() => this.openSocket())
        .catch(() => this.scheduleNoticeRecovery());
    }, 5 * 60_000);
    this.pollTimer.unref();
  }

  private async openSocket(): Promise<void> {
    if (this.closed || !this.state.notifications || this.socket) return;
    const auth = this.auth;
    const credentials = await this.scoped((current) =>
      current.socketCredentials(this.cursor.sequence),
    );
    if (auth !== this.auth || !this.state.notifications || this.socket) return;
    const socket = new WebSocket('wss://wx.mail.qq.com/socket', {
      headers: { Cookie: credentials.cookie, Origin: 'https://wx.mail.qq.com' },
      handshakeTimeout: 10_000,
      maxPayload: 512 * 1024,
      perMessageDeflate: false,
    });
    this.socket = socket;
    socket.on('open', () => {
      if (this.socket === socket && this.state.notifications) socket.send(credentials.frame);
      else socket.close();
    });
    socket.on('message', (bytes) => {
      if (this.socket !== socket || this.closed) return;
      try {
        const event = decodeMailSocketFrame(bytes.toString());
        this.reconnectAttempt = 0;
        if (event.kind === 'baseline') {
          if (this.cursor.sequence > 0 && event.sequence !== this.cursor.sequence)
            this.events.emit('change', { type: 'changed' });
          this.cursor.sequence = event.sequence;
        } else if (event.sequence === 0 || event.sequence > this.cursor.sequence) {
          this.cursor.sequence = Math.max(this.cursor.sequence, event.sequence);
          if (event.kind === 'mail' && this.cursor.accept(event.notice.id))
            this.events.emit('change', { type: 'new-mail', notice: event.notice });
          this.events.emit('change', { type: 'changed' });
          void this.syncNotice(false).catch(() => this.scheduleNoticeRecovery());
        }
      } catch {
        socket.close();
      }
    });
    socket.on('error', () => {
      /* 底层错误可能含请求信息，由 close 分支统一恢复。 */
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed || !this.state.notifications) return;
      const delay = Math.min(300_000, 5000 * 2 ** Math.min(6, this.reconnectAttempt++));
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.openSocket().catch(() => this.scheduleNoticeRecovery());
      }, delay);
      this.reconnectTimer.unref();
    });
  }

  private stopNotifications(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pollTimer = this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.removeAllListeners();
      socket.on('error', () => {});
      socket.terminate();
    }
  }

  disconnect(): void {
    if (this.closed) return;
    this.stopNotifications();
    this.auth.dispose();
    this.auth = this.makeAuth();
    this.attachments.clear();
    this.totals.clear();
    this.cursor = new MailNoticeCursor();
    this.update({
      state: 'disconnected',
      unread: 0,
      notifications: false,
      error: null,
      lastSync: null,
    });
  }

  dispose(): void {
    this.closed = true;
    this.stopNotifications();
    this.auth.dispose();
    this.attachments.clear();
    this.totals.clear();
    this.events.removeAllListeners();
  }
}
