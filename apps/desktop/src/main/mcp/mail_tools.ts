import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { htmlPlainText } from '@weq/service';
import type { MailDetail, MailSummary, QQMailService } from '@weq/service/mail';
import { basename } from 'node:path';

const MAX_BODY_LENGTH = 24_000;
const MAX_LINKS = 100;
export const MCP_MAIL_ATTACHMENT_LIMIT = 64 * 1024 * 1024;
export const MCP_MAIL_ATTACHMENT_ROUTE = '/mail/attachments/';
const ignoredTags = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'svg']);

export function mailSummaryForTool(mail: MailSummary) {
  return {
    id: mail.id,
    folderId: mail.folderId,
    subject: mail.subject,
    snippet: mail.snippet,
    sender: mail.sender,
    time: mail.time,
    unread: mail.unread,
    hasAttachments: mail.hasAttachments,
  };
}

function httpsLinks(html: string, hosts: string[]): string[] {
  if (!hosts.length) return [];
  const allowed = new Set(hosts.map((host) => host.toLowerCase()));
  const links = new Set<string>();
  function visit(node: DefaultTreeAdapterMap['node'], depth: number): void {
    if (depth > 128 || links.size >= MAX_LINKS) return;
    if ('tagName' in node) {
      if (
        ignoredTags.has(node.tagName) ||
        node.attrs.some(
          (attr) =>
            attr.name === 'hidden' || (attr.name === 'aria-hidden' && attr.value === 'true'),
        )
      )
        return;
      const href =
        node.tagName === 'a' ? node.attrs.find((attr) => attr.name === 'href')?.value : undefined;
      if (href && href.length <= 8_192) {
        try {
          const url = new URL(href);
          if (
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            !url.port &&
            allowed.has(url.hostname)
          )
            links.add(url.href);
        } catch {
          /* malformed or relative links are not returned */
        }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, depth + 1);
  }
  visit(parseFragment(html), 0);
  return [...links];
}

export function mailDetailForTool(
  detail: MailDetail & { bodyAvailable: boolean },
  linkHosts: string[],
) {
  const text = detail.bodyAvailable ? htmlPlainText(detail.html) : '';
  return {
    ...mailSummaryForTool(detail),
    recipients: detail.to,
    bodyAvailable: detail.bodyAvailable,
    text: text.slice(0, MAX_BODY_LENGTH),
    truncated: text.length > MAX_BODY_LENGTH,
    links: detail.bodyAvailable ? httpsLinks(detail.html, linkHosts) : [],
    attachments: detail.attachments.map(({ id, name, size, big, available }) => ({
      id,
      name,
      size,
      big,
      available,
    })),
    thread: detail.thread?.map(mailSummaryForTool),
  };
}

export function mailAttachmentForTool(mail: QQMailService, id: string) {
  const attachment = mail.attachments.get(id);
  if (attachment.size <= 0 || attachment.size > MCP_MAIL_ATTACHMENT_LIMIT)
    throw new Error('MCP 仅支持已知大小且不超过 64 MiB 的邮件附件；请在 WeQ 邮箱界面下载此附件。');
  return {
    name: basename(attachment.name.replaceAll('\\', '/')) || '附件',
    size: attachment.size,
    downloadPath: `${MCP_MAIL_ATTACHMENT_ROUTE}${id}`,
  };
}
