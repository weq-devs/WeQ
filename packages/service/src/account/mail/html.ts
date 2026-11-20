import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import type { MailAttachmentRegistry } from './attachments';
import { MAIL_ORIGIN, isMailDownloadHost } from './wire';

/** 图片统一使用令牌，邮箱票据留在主进程。HTML 净化由渲染端 DOMPurify 承担。 */
export function protectMailHtml(html: string, registry: MailAttachmentRegistry): string {
  const fragment = parseFragment(html);
  const imageIds = new Map<string, string>();
  const visit = (node: DefaultTreeAdapterMap['node']): void => {
    if ('tagName' in node) {
      if (node.tagName === 'img') {
        node.attrs = node.attrs.filter(
          (attr) => !['srcset', 'data-mail-inline'].includes(attr.name),
        );
        const src = node.attrs.find((attr) => attr.name === 'src')?.value.trim();
        try {
          if (src) {
            const url = new URL(src, MAIL_ORIGIN);
            if (url.protocol === 'http:' && isMailDownloadHost(url.hostname))
              url.protocol = 'https:';
            if (url.protocol === 'https:') {
              const id =
                imageIds.get(url.href) ??
                (imageIds.size < 100 ? registry.registerImage(url) : undefined);
              node.attrs = node.attrs.filter((attr) => attr.name !== 'src');
              if (id) {
                imageIds.set(url.href, id);
                node.attrs.push({ name: 'data-mail-inline', value: id });
              }
            }
          }
        } catch {
          node.attrs = node.attrs.filter((attr) => attr.name !== 'src');
        }
      }
      // 邮箱内部链接不把会话参数带到外部浏览器或渲染进程。
      for (const attr of node.attrs) {
        if (!['href', 'action', 'poster', 'background'].includes(attr.name)) continue;
        try {
          const url = new URL(attr.value, MAIL_ORIGIN);
          if (isMailDownloadHost(url.hostname)) {
            for (const key of ['sid', 'skey', 'p_skey', 'clientkey', 'code'])
              url.searchParams.delete(key);
            attr.value = url.href;
          }
        } catch {
          attr.value = '';
        }
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    if ('content' in node) visit(node.content);
  };
  visit(fragment);
  return serialize(fragment);
}
