import { LinkifyIt } from 'linkify-it';

// 邮件也交给解析器消费，但不生成链接，避免把邮箱的域名截成独立网址。
const linkify = new LinkifyIt({ fuzzyLink: true, fuzzyIP: false, fuzzyEmail: true }).add(
  'ftp:',
  null,
);
const DOCUMENT_NAME = /^(?:readme|changelog|contributing|license|agents)\.(?:md|rst|txt)$/i;

function isWebMatch(schema: string, raw: string): boolean {
  return schema ? schema === 'http:' || schema === 'https:' : !DOCUMENT_NAME.test(raw);
}

export function hasTextLink(text: string): boolean {
  return linkify.match(text)?.some(({ schema, raw }) => isWebMatch(schema, raw)) ?? false;
}

export interface LinkPart {
  kind: 'text' | 'link';
  /** 原文（链接片段保留用户写的原样，用于显示）。 */
  text: string;
  /** 链接片段的规范化地址（裸域名补上 https://）；文字片段为空串。 */
  href: string;
}

/** 把一段文本切成文字/链接片段。没有链接时返回单个 text 片段。 */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let cursor = 0;
  for (const match of linkify.match(text) ?? []) {
    if (!isWebMatch(match.schema, match.raw)) continue;
    if (match.index > cursor)
      parts.push({ kind: 'text', text: text.slice(cursor, match.index), href: '' });
    const href = match.schema ? match.raw : `https://${match.raw}`;
    parts.push({ kind: 'link', text: match.raw, href });
    cursor = match.lastIndex;
  }
  if (cursor < text.length) parts.push({ kind: 'text', text: text.slice(cursor), href: '' });
  return parts;
}
