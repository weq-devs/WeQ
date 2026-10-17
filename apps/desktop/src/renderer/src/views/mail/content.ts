import DOMPurify from 'dompurify';
import { validMailAddress } from '@weq/service/mail-wire';
import type { MailAddress, MailDetail } from '@weq/service/mail';

export function mailError(error: unknown): string {
  return error instanceof Error ? error.message : '邮箱操作失败，请重试。';
}

export function formatMailTime(time: number, short = false): string {
  if (!time) return '-';
  return new Date(time * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    ...(short
      ? { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }
      : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
  });
}

export function formatMailSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function parseMailRecipients(value: string): MailAddress[] {
  const result: MailAddress[] = [];
  for (const part of value
    .split(/[,;\n]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const bracket = /^(.*?)<([^<>]+)>$/.exec(part);
    const email = (bracket?.[2] ?? part).trim();
    const name = (bracket?.[1] ?? '').trim().replace(/^"|"$/g, '');
    if (name.length > 256) throw new Error('收件人名称过长。');
    if (!validMailAddress(email)) throw new Error('请填写有效的邮箱地址。');
    if (!result.some((entry) => entry.email.toLowerCase() === email.toLowerCase()))
      result.push({ email, name });
  }
  return result;
}

export function addressText(addresses: readonly MailAddress[]): string {
  return addresses.map((entry) => entry.email).join(', ');
}

export function sanitizeMailEditorHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'br',
      'div',
      'span',
      'b',
      'strong',
      'i',
      'em',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'blockquote',
      'pre',
      'code',
      'a',
    ],
    ALLOWED_ATTR: ['href'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['style', 'script', 'template'],
  });
}

export function plainMailText(html: string): string {
  const fragment = DOMPurify.sanitize(html.replace(/<(?:br|\/p|\/div|\/li)>/gi, '$&\n'), {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'img', 'template'],
    FORBID_ATTR: ['src', 'srcset'],
  });
  return fragment.textContent ?? '';
}

export function textMailHtml(text: string): string {
  const node = document.createElement('div');
  node.textContent = text;
  return node.innerHTML.replace(/\n/g, '<br>');
}

export function mailExternalLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function mailBodyFragment(html: string, images: boolean): DocumentFragment {
  const fragment = DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    SANITIZE_NAMED_PROPS: true,
    FORBID_TAGS: [
      'style',
      'script',
      'form',
      'iframe',
      'object',
      'embed',
      'link',
      'meta',
      'base',
      'template',
      'input',
      'button',
      'textarea',
      'video',
      'audio',
      'source',
    ],
    FORBID_ATTR: images
      ? ['srcset', 'ping', 'target', 'download', 'autofocus', 'contenteditable']
      : ['src', 'srcset', 'ping', 'target', 'download', 'autofocus', 'contenteditable'],
  });
  for (const link of fragment.querySelectorAll('a')) {
    const value = link.getAttribute('href') ?? '';
    if (!value.startsWith('#') && !mailExternalLink(value)) link.removeAttribute('href');
    link.setAttribute('rel', 'noreferrer noopener');
  }
  for (const image of fragment.querySelectorAll('img')) {
    const value = image.getAttribute('src') ?? '';
    if (
      value &&
      !value.startsWith('https://') &&
      !/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value)
    )
      image.removeAttribute('src');
  }
  return fragment;
}

export function inlineMailImages(html: string): string[] {
  return [
    ...new Set(
      [...mailBodyFragment(html, false).querySelectorAll('img[data-mail-inline]')]
        .map((image) => image.getAttribute('data-mail-inline') ?? '')
        .filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
    ),
  ].slice(0, 100);
}

export function mailDocument(
  html: string,
  images: boolean,
  sources: Record<string, string>,
): string {
  const fragment = mailBodyFragment(html, images);
  if (images)
    for (const image of fragment.querySelectorAll('img[data-mail-inline]')) {
      const value = sources[image.getAttribute('data-mail-inline') ?? ''];
      if (value && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(value))
        image.setAttribute('src', value);
    }
  const holder = document.createElement('div');
  holder.append(fragment);
  const csp = `default-src 'none'; script-src 'none'; img-src data:${images ? ' https:' : ''}; style-src 'unsafe-inline'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`;
  const style = `html{color:var(--mail-fg);color-scheme:var(--mail-scheme)}
body{margin:0;padding:20px;font:14px/1.65 system-ui,sans-serif;overflow-wrap:anywhere;background:transparent}
img,table{max-width:100%}img{height:auto}img:not([src]){display:none}
a{color:var(--mail-accent)}a:not([href]){color:inherit;text-decoration:none}pre{white-space:pre-wrap}
blockquote{margin:12px 0;padding-inline-start:16px;border-inline-start:2px solid currentColor;opacity:.85}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${style}</style></head><body>${holder.innerHTML}</body></html>`;
}

export interface MailDraft {
  key: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  content: string;
  plainText: boolean;
  attachments: MailDetail['attachments'];
  replyId?: string;
  forwardId?: string;
  draftId?: string;
}

export function newMailDraft(): MailDraft {
  return {
    key: crypto.randomUUID(),
    to: '',
    cc: '',
    bcc: '',
    subject: '',
    content: '',
    plainText: false,
    attachments: [],
  };
}

export function draftFromMail(
  mail: MailDetail,
  mode: 'reply' | 'all' | 'forward' | 'edit',
  selfEmail: string,
): MailDraft {
  const draft = newMailDraft();
  if (mode === 'edit')
    return {
      ...draft,
      draftId: mail.id,
      to: addressText(mail.to),
      cc: addressText(mail.cc),
      bcc: addressText(mail.bcc),
      subject: mail.subject,
      content: sanitizeMailEditorHtml(mail.html),
      attachments: mail.attachments.filter((item) => item.available),
    };
  const sender = mail.replyTo?.email ? mail.replyTo : mail.sender;
  const recipients =
    mode === 'forward'
      ? []
      : [sender, ...(mode === 'all' ? mail.to : [])].filter(
          (entry) => entry.email && entry.email.toLowerCase() !== selfEmail.toLowerCase(),
        );
  const unique = recipients.filter(
    (entry, index) =>
      recipients.findIndex(
        (candidate) => candidate.email.toLowerCase() === entry.email.toLowerCase(),
      ) === index,
  );
  return {
    ...draft,
    to: addressText(unique),
    cc:
      mode === 'all'
        ? addressText(
            mail.cc.filter(
              (entry) =>
                entry.email.toLowerCase() !== selfEmail.toLowerCase() &&
                !unique.some(
                  (candidate) => candidate.email.toLowerCase() === entry.email.toLowerCase(),
                ),
            ),
          )
        : '',
    subject: `${mode === 'forward' ? 'Fwd' : 'Re'}: ${mail.subject.replace(/^(?:Re|Fwd?):\s*/i, '')}`,
    content: `<p><br></p><blockquote>${textMailHtml(`发件人：${mail.sender.name || mail.sender.email}\n日期：${formatMailTime(mail.time)}\n主题：${mail.subject}`)}<br>${sanitizeMailEditorHtml(mail.html)}</blockquote>`,
    replyId: mode === 'forward' ? undefined : mail.id,
    forwardId: mode === 'forward' ? mail.id : undefined,
    attachments: mode === 'forward' ? mail.attachments.filter((item) => item.available) : [],
  };
}
