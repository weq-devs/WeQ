import {
  MailFailure,
  type MailAddress,
  type MailComposeInput,
  type MailFolder,
  type MailSummary,
} from './types';

export type MailObject = Record<string, unknown>;
export const MAIL_ORIGIN = 'https://wx.mail.qq.com';
export const MAIL_PAGE_SIZE = 30;
export const MAIL_PART_SIZE = 5 * 1024 * 1024;

export function isMailThreadId(id: string): boolean {
  return id.startsWith('C') && !id.startsWith('CAD');
}

export function object(value: unknown): MailObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as MailObject)
    : {};
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export function items(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const entry = object(value);
  return Array.isArray(entry.item) ? entry.item : [];
}

export function mailAddress(value: unknown): MailAddress {
  const entry = object(value);
  return { email: text(entry.email), name: text(entry.nick ?? entry.name) };
}

export function mailAddresses(value: unknown): MailAddress[] {
  return items(value)
    .map(mailAddress)
    .filter((entry) => entry.email.length > 0);
}

export function mailSummary(value: unknown): MailSummary {
  const raw = object(value);
  const entry = { ...raw, ...object(raw.info) };
  const senders = mailAddresses(entry.senders);
  return {
    id: text(entry.emailid),
    folderId: count(entry.dirid),
    messageId: text(entry.messageid),
    subject: text(entry.subject),
    snippet: text(entry.maildigest),
    sender: senders[0] ?? mailAddress(entry.from),
    to: mailAddresses(entry.to ?? entry.receivers),
    cc: mailAddresses(entry.cc),
    bcc: mailAddresses(entry.bcc),
    time: count(entry.timer) === 1 ? count(entry.sendtime) : count(entry.fromtime ?? entry.totime),
    size: count(entry.size),
    unread: count(entry.unread) > 0,
    starred: count(entry.star) === 1,
    hasAttachments:
      count(entry.attach) === 1 ||
      items(entry.normal_attach).length > 0 ||
      items(entry.big_attach).length > 0,
    draft: count(entry.dirid) === 4 && count(entry.timer) !== 1,
  };
}

export const SYSTEM_MAIL_FOLDERS: readonly MailFolder[] = [
  { id: 1, name: '收件箱', unread: 0, total: 0, locked: false },
  { id: 2, name: '星标邮件', unread: 0, total: 0, locked: false },
  { id: 3, name: '已发送', unread: 0, total: 0, locked: false },
  { id: 4, name: '草稿箱', unread: 0, total: 0, locked: false },
  { id: 5, name: '已删除', unread: 0, total: 0, locked: false },
  { id: 6, name: '垃圾邮件', unread: 0, total: 0, locked: false },
];

export function mailFolders(value: unknown): MailFolder[] {
  const seen = new Map(SYSTEM_MAIL_FOLDERS.map((folder) => [folder.id, { ...folder }]));
  const groups = object(value);
  const source = Array.isArray(value)
    ? value
    : ['sys_list', 'personal_list', 'pop_list', 'tag_list'].flatMap((key) => items(groups[key]));
  for (const raw of source) {
    const entry = object(raw);
    const id = count(entry.id ?? entry.dirid);
    if (!id || !Number.isSafeInteger(id) || (id >= 1000 && id < 2000)) continue;
    const fallback = seen.get(id);
    seen.set(id, {
      id,
      name: text(entry.name ?? entry.dir_name) || fallback?.name || `文件夹 ${id}`,
      unread: count(entry.unread ?? entry.unread_num),
      total: count(entry.total ?? entry.total_num),
      locked: count(entry.lock ?? entry.locked) > 0,
    });
  }
  return [...seen.values()];
}

export function encodeMailForm(params: MailObject): string {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue;
      form.append(key, typeof item === 'object' ? JSON.stringify(item) : String(item));
    }
  }
  return form.toString();
}

export function mailEnvelope(value: unknown): MailObject {
  const envelope = object(value);
  const head = object(envelope.head);
  const code = text(head.ret);
  if (code === '0') return object(envelope.body);
  if (code === '-20002' || code === '-20062' || code === '-39005') {
    throw new MailFailure('auth', '邮箱登录已失效，请重新连接。', code);
  }
  throw new MailFailure(
    'business',
    code ? `邮箱请求失败（${code}）。` : '邮箱返回了无法识别的响应。',
    code || undefined,
  );
}

export function validMailAddress(email: string): boolean {
  return (
    email.length <= 254 &&
    /^[^\s<>"(),;:\\@\r\n]+@[^\s<>"(),;:\\@\r\n]+\.[^\s<>"(),;:\\@\r\n]+$/.test(email)
  );
}

export function addressHeader(address: MailAddress): string {
  if (!validMailAddress(address.email)) throw new MailFailure('business', '请填写有效的邮箱地址。');
  const name = address.name.replace(/[\r\n]/g, '').replace(/["\\]/g, '\\$&');
  return name ? `"${name}"<${address.email}>` : address.email;
}

export function composeMailForm(
  input: MailComposeInput,
  sender: MailAddress,
  draft: boolean,
): MailObject {
  if (!draft && input.to.length + input.cc.length + input.bcc.length === 0)
    throw new MailFailure('business', '请填写收件人。');
  if (input.to.length + input.cc.length + input.bcc.length > 100)
    throw new MailFailure('business', '单封邮件最多填写 100 个收件人。');
  return {
    func: draft ? 2 : 1,
    mailid: input.draftId,
    re_mailid: input.replyId,
    fw_mailid: input.forwardId,
    subject: input.subject,
    content: input.content,
    is_text: input.plainText,
    from: addressHeader(sender),
    to: input.to.map(addressHeader),
    cc: input.cc.map(addressHeader),
    bcc: input.bcc.map(addressHeader),
    save_to_send: true,
    is_receipt: false,
    need_receipt: false,
    separated_copy: false,
    manual_save: draft ? true : undefined,
    time_zone: -new Date(2009, 0, 1).getTimezoneOffset() * 60,
    time_zone_dst: (new Date(2009, 0, 1).getTimezoneOffset() - new Date().getTimezoneOffset()) * 60,
  };
}

export function isMailDownloadHost(host: string): boolean {
  return (
    host === 'mail.qq.com' ||
    host.endsWith('.mail.qq.com') ||
    host === 'qqmail.com' ||
    host.endsWith('.qqmail.com')
  );
}
