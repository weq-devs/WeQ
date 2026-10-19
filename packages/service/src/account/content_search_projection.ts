import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { htmlPlainText } from '../common/html_text';
import type { ContentSearchRecord } from './content_search';
import type { QzoneFeed } from './web/qzone';

/** 与查看器采用同一组已知属性；未知 feed key 不猜成说说 tid。 */
export function qzoneFeedSearchRecord(feed: QzoneFeed): ContentSearchRecord | null {
  if (feed.appid !== 311 || !feed.uin) return null;
  let primary: Record<string, string> | null = null;
  let fallback: string | null = null;
  let advertisement = false;
  let body: DefaultTreeAdapterMap['element'] | null = null;
  let item: DefaultTreeAdapterMap['element'] | null = null;
  const visit = (node: DefaultTreeAdapterMap['node'], depth: number) => {
    if (depth > 128) return;
    if ('tagName' in node) {
      const attrs = Object.fromEntries(node.attrs.map((attr) => [attr.name, attr.value]));
      const classes = (attrs.class ?? '').split(/\s+/);
      if (!body && classes.some((name) => name === 'f-content' || name === 'f-single-content'))
        body = node;
      if (!item && classes.includes('f-item')) item = node;
      if (attrs['data-tid'] === 'advertisement_app') advertisement = true;
      if (!primary && ('data-fkey' in attrs || 'data-tid' in attrs)) primary = attrs;
      fallback ??= attrs['data-key'] ?? null;
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, depth + 1);
  };
  const fragment = parseFragment(feed.html);
  visit(fragment, 0);
  const attrs = primary as Record<string, string> | null;
  const raw = attrs?.['data-tid'];
  const tid = attrs?.['data-fkey'] || (raw && /^\d+$/.test(raw) ? fallback || raw : raw);
  if (advertisement || !tid || !/^[a-zA-Z0-9_-]{1,128}$/.test(tid)) return null;
  const omit = new Set([
    'f-logs',
    'f-reply',
    'f-reply-wrap',
    'f-op',
    'f-detail',
    'comments-list',
    'user-list',
    'f-user-info',
    'f-single-head',
    'f-single-foot',
    'mod-comments',
    'user-info',
    'user-pto',
    'user-avatar',
    'f-single-top',
  ]);
  const prune = (node: DefaultTreeAdapterMap['node'], depth: number) => {
    if (!('childNodes' in node)) return;
    if (depth >= 128) {
      node.childNodes = [];
      return;
    }
    node.childNodes = node.childNodes.filter(
      (child) =>
        !('tagName' in child) ||
        (!['form', 'input', 'button', 'textarea'].includes(child.tagName) &&
          !child.attrs.some(
            (attr) =>
              attr.name === 'class' && attr.value.split(/\s+/).some((name) => omit.has(name)),
          )),
    );
    for (const child of node.childNodes) prune(child, depth + 1);
  };
  const visible = body ?? item ?? fragment;
  prune(visible, 0);
  return {
    target: { kind: 'qzonePost', uin: String(feed.uin), tid },
    title: feed.nickname || String(feed.uin),
    content: htmlPlainText(serialize(visible)),
    sourceName: `空间 ${feed.uin}`,
    time: feed.time,
  };
}
