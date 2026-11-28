/**
 * AI 助手（小Q）的卡片渲染。
 *
 * 一条 AI 回复的正文 markdown 里，卡片以
 * `[](qagent://markdown/node?type=…&id=…)` 占位符出现，真正的数据在同一个
 * 48707 的 `cardPayload` 里（服务层已解析成 segments）。三种卡片：
 *
 *   qui   — 结构化卡片：`data` 是一组「段」，每段是若干 `full_title` /
 *           `full_title_text` / `full_bottom_buttons` / `composite_list_item`
 *           之类的块。好友推荐与授权申请都是它。
 *   quser — 极简用户卡：`{peerUid, peerUin, peerName}`，渲染成带头像的可点名字。
 *   qlink — 外链：`{title, url}`。
 *
 * 静态展示：卡片按钮一律只读（AI 助手的按钮走 qqaiapi:// 协议，需要 QQ 在线
 * 才能生效），只保留可点外链与「查看资料」这类本机可完成的动作。
 */

import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { qlinkCardInfo, quserCardInfo } from '@weq/codec';
import { openLink } from '../../lib/linkify';
import { avatarFromUin } from '../../lib/avatarResolver';
import type { AiSegmentWire } from '../../../../shared/aiAssistantTypes';
import { AvatarPicture } from '../AvatarPicture';

export type AiCardPayload = Extract<AiSegmentWire, { kind: 'card' }>['card'];

/** 一个卡片段：正文里出现卡片占位符的位置。 */
export function AiCard({ card, children }: { card: AiCardPayload; children?: ReactNode }) {
  switch (card.type) {
    case 'quser':
      return <QuserCard card={card}>{children}</QuserCard>;
    case 'qlink':
      return <QlinkCard card={card}>{children}</QlinkCard>;
    case 'qui':
      return <QuiCard card={card} />;
    default:
      return null;
  }
}

// ── quser ─────────────────────────────────────────────────────────────────

function QuserCard({ card, children }: { card: AiCardPayload; children?: ReactNode }) {
  const { peerUin, peerName } = quserCardInfo(card);
  const avatar = /^\d+$/.test(peerUin) ? avatarFromUin(peerUin, 100) : null;
  return (
    <span className="ai-quser">
      <AvatarPicture className="ai-quser-avatar" src={avatar} />
      <span>{children ?? (peerName || peerUin)}</span>
    </span>
  );
}

// ── qlink ─────────────────────────────────────────────────────────────────

function QlinkCard({ card, children }: { card: AiCardPayload; children?: ReactNode }) {
  const link = qlinkCardInfo(card);
  const href = httpUrlOf(link?.url ?? '');
  const label = children ?? (link?.title || href);
  if (!href) return label;
  return (
    <button
      type="button"
      className="ai-qlink"
      title={href}
      onClick={(event) => {
        event.stopPropagation();
        void openLink(href, event.currentTarget.ownerDocument);
      }}
    >
      {label}
    </button>
  );
}

// ── qui ───────────────────────────────────────────────────────────────────

interface QuiBlock {
  kind: 'title' | 'titleText' | 'buttons' | 'listItem' | 'feed';
  record: Record<string, unknown>;
}

/** 把 `data` 的每段（数组）摊平成块，未知块跳过。 */
function quiBlocks(card: AiCardPayload): QuiBlock[] {
  const data = card.payload.data;
  if (!Array.isArray(data)) return [];
  const blocks: QuiBlock[] = [];
  for (const segment of data) {
    if (!Array.isArray(segment)) continue;
    for (const item of segment) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.full_title)
        blocks.push({ kind: 'title', record: record.full_title as Record<string, unknown> });
      else if (record.full_title_text)
        blocks.push({
          kind: 'titleText',
          record: record.full_title_text as Record<string, unknown>,
        });
      else if (record.full_bottom_buttons)
        blocks.push({
          kind: 'buttons',
          record: record.full_bottom_buttons as Record<string, unknown>,
        });
      else if (record.composite_list_item)
        blocks.push({
          kind: 'listItem',
          record: record.composite_list_item as Record<string, unknown>,
        });
      else if (record.full_feed_card)
        blocks.push({ kind: 'feed', record: record.full_feed_card as Record<string, unknown> });
    }
  }
  return blocks;
}

/**
 * 结构化卡片。外层按段拼：标题 → 正文 → 候选列表 → 底部按钮。
 *
 * 候选列表（`composite_list_item`）是好友推荐：头像 + 名字 + 标签 + 相册缩略图 +
 * 「去添加」按钮。授权申请只有 title / titleText / 一个「允许」按钮。
 */
function QuiCard({ card }: { card: AiCardPayload }) {
  const blocks = quiBlocks(card);
  if (!blocks.length) return null;
  const listItems = blocks.filter((b) => b.kind === 'listItem');
  const feeds = blocks.filter((b) => b.kind === 'feed');
  const buttons = blocks.filter((b) => b.kind === 'buttons');
  const header = blocks.filter((b) => b.kind === 'title' || b.kind === 'titleText');

  return (
    <div className="ai-qui-card">
      {header.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 卡片块没有稳定 id，段顺序即身份
        <QuiHeader key={index} block={block} />
      ))}
      {listItems.length ? (
        <div className="ai-qui-list">
          {listItems.map((block, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 候选列表没有稳定 id，顺序即身份
            <QuiListItem key={index} record={block.record} />
          ))}
        </div>
      ) : null}
      {feeds.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 动态卡片位置即身份
        <QuiFeed key={index} record={block.record} />
      ))}
      {buttons.map((block, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 按钮组没有稳定 id，顺序即身份
        <QuiButtons key={index} record={block.record} />
      ))}
    </div>
  );
}

function QuiHeader({ block }: { block: QuiBlock }) {
  if (block.kind === 'title') {
    const title = str(block.record.title);
    if (!title) return null;
    return <div className="ai-qui-eyebrow">{title}</div>;
  }
  const title = str(block.record.title);
  const text = str(block.record.text);
  if (!title && !text) return null;
  return (
    <div className="ai-qui-header">
      {title ? <div className="ai-qui-title">{title}</div> : null}
      {text ? <div className="ai-qui-text">{text}</div> : null}
    </div>
  );
}

function QuiListItem({ record }: { record: Record<string, unknown> }) {
  const title = str(record.title);
  const icon = httpUrlOf(str(record.iconImageUrl));
  const qqIcon = icon && qqAvatarSource(icon);
  const labels = parseLabels(record.labelsItems);
  const pics = pickPics(record);
  const buttonText = str(record.buttonText);
  const buttonSchema = str(record.buttonSchema || record.schema);
  const href = httpUrlOf(buttonSchema);
  return (
    <div className="ai-qui-item">
      <div className="ai-qui-item-head">
        {qqIcon ? (
          <AvatarPicture className="ai-qui-item-avatar" src={qqIcon} />
        ) : (
          icon && <img className="ai-qui-item-avatar" src={icon} alt="" loading="lazy" />
        )}
        <div className="ai-qui-item-main">
          <div className="ai-qui-item-title">{title}</div>
          {labels.length ? (
            <div className="ai-qui-item-labels">
              {labels.map((label, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 标签可重复，位置即身份
                <span key={index} className="ai-qui-item-label">
                  {label}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {pics.length ? (
        <div className="ai-qui-item-pics">
          {pics.map((url, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 相册图位置即身份
            <img key={index} src={url} alt="" loading="lazy" />
          ))}
        </div>
      ) : null}
      {buttonText ? (
        <QuiStaticButton label={buttonText} href={href} title={href ?? undefined} />
      ) : null}
    </div>
  );
}

function QuiFeed({ record }: { record: Record<string, unknown> }) {
  const author = str(record.author);
  const avatar = str(record.avatar);
  const avatarSrc = /^\d+$/.test(avatar) ? avatarFromUin(avatar, 100) : qqAvatarSource(avatar);
  const subtitle = str(record.subTitle);
  const body = str(record.body);
  const media =
    record.mediaVisible !== false && Array.isArray(record.mediaItems)
      ? record.mediaItems.flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const url = httpUrlOf(str(item.thumb) || str(item.url));
          return url ? [url] : [];
        })
      : [];
  return (
    <div className="ai-qui-item">
      <div className="ai-qui-item-head">
        <AvatarPicture className="ai-qui-item-avatar" src={avatarSrc} />
        <div className="ai-qui-item-main">
          <div className="ai-qui-item-title">{author}</div>
          {subtitle ? <div className="ai-qui-text">{subtitle}</div> : null}
        </div>
      </div>
      {body ? <div className="ai-qui-feed-body">{body}</div> : null}
      {media.length ? (
        <div className="ai-qui-item-pics">
          {media.slice(0, 6).map((src, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 缩图位置即身份
            <img key={index} src={src} alt="" loading="lazy" />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function QuiButtons({ record }: { record: Record<string, unknown> }) {
  // full_bottom_buttons 的按钮按 button1/button2/button3 编号，文案在
  // `buttonNText`，跳转在 `buttonNSchema`，可见性在 `buttonNVisible`。
  const buttons: Array<{ label: string; href: string | null }> = [];
  for (let i = 1; i <= 4; i += 1) {
    const label = str(record[`button${i}Text`]);
    const visible = record[`button${i}Visible`];
    if (!label || visible === 'false' || visible === false) continue;
    buttons.push({ label, href: httpUrlOf(str(record[`button${i}Schema`])) });
  }
  if (!buttons.length) return null;
  return (
    <div className="ai-qui-buttons">
      {buttons.map((button, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 底部按钮位置即身份
        <QuiStaticButton key={index} label={button.label} href={button.href} />
      ))}
    </div>
  );
}

/** 静态按钮：有 http(s) 目标时可点，否则只读展示。 */
function QuiStaticButton({
  label,
  href,
  title,
}: {
  label: string;
  href: string | null;
  title?: string;
}) {
  if (href) {
    return (
      <button
        type="button"
        className="ai-qui-button is-link"
        title={title ?? href}
        onClick={(event) => void openLink(href, event.currentTarget.ownerDocument)}
      >
        <ExternalLink size={12} aria-hidden />
        <span className="truncate">{label}</span>
      </button>
    );
  }
  return (
    <span className="ai-qui-button is-static" aria-disabled="true">
      {label}
    </span>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** `labelsItems` 是一段 JSON 字符串：`[{text, icon?}, …]`。 */
function parseLabels(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) =>
        item && typeof item === 'object' ? str((item as Record<string, unknown>).text) : '',
      )
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** 候选人的相册缩略图：pic1Url…pic10Url。 */
function pickPics(record: Record<string, unknown>): string[] {
  const pics: string[] = [];
  for (let i = 1; i <= 10; i += 1) {
    const url = str(record[`pic${i}Url`]);
    if (url) pics.push(url);
  }
  return pics.slice(0, 6);
}

/**
 * 卡片 schema 通常是 `mqqapi://jumpx?…default_url=<编码后的 mqqapi>…`，
 * 其中没有 http(s)。只有少数直接给 http 链接，其余静态模式下一律不跳转。
 */
function httpUrlOf(schema: string): string | null {
  return /^https?:\/\//i.test(schema) ? schema : null;
}

function qqAvatarSource(value: string): string | null {
  if (!httpUrlOf(value)) return null;
  try {
    const url = new URL(value);
    return !url.username && !url.password && /(^|\.)qlogo\.cn$/i.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
