/**
 * 链接卡片 —— 一条消息只有一个裸链接时，在气泡下方补一张「标题 + 描述 + 封面 + 站点」。
 *
 * 两个数据源，优先级从高到低：
 *   1. `info` —— QQ 随消息保存的元数据，标题和描述直接画，封面优先读本地缓存。
 *   2. LinkPreviewService —— 先读本地预览，允许联网补全时才抓元数据及图片。
 *
 * 站点资料和封面陆续返回时保留时间线的阅读位置。
 *
 * 视觉沿用 ARK 卡片那一套 class（weq-ark-*），因为它们在聊天流里已经是「卡片」的既定
 * 语言，没必要再造一套。
 */

import { memo, useContext, useRef, type ReactElement } from 'react';
import { Link2 } from 'lucide-react';
import type { UrlVerifyInfo } from '@weq/service';
import { trpc } from '../trpc/client';
import { linkPreviewImageUrl } from '../lib/resourceUrl';
import { openLink } from '../lib/linkify';
import { useDataSaver } from '../lib/dataSaver';
import { LinkPreviewContext } from '../state/messageAppearance';
import { MessageLayoutChange } from './MessageExpansion';

/** 卡片实际需要的几个字段，抹平「QQ 自带」与「自己抓」两种来源。 */
interface CardData {
  url: string;
  title: string;
  desc: string;
  siteName: string;
  /** 已经可以直接塞进 <img src> 的地址（本地缓存或代理）。 */
  cover: string;
  /** og 图按常规裁切，整页截图按顶部对齐。 */
  imageKind: 'og' | 'shot' | '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export const QqLinkCard = memo(function QqLinkCard({
  url,
  info,
}: {
  url: string;
  info?: UrlVerifyInfo;
}): ReactElement {
  const anchor = useRef<HTMLSpanElement>(null);
  const { autoFetch } = useContext(LinkPreviewContext);
  const restricted = useDataSaver(
    (state) => state.enabled && !state.behavior.dataSaverLinkPreviews,
  );
  const cacheOnly = !autoFetch || restricted;
  // 结果在主进程按 URL 落盘缓存，所以这里放心地按 url 做 query key；抓取失败返回
  // null（短 TTL 内不再重试）。QQ 已经给了元数据时整个 query 都不发。
  const preview = trpc.bootstrap.linkPreview.useQuery(
    { url, cacheOnly },
    { enabled: !info, staleTime: Number.POSITIVE_INFINITY, retry: false },
  );
  // QQ 给的封面只是个远端地址，字节还得主进程去取（同一套 SSRF 闸门 + 魔数校验），
  // 落盘后按 id 走 weq-media://linkpreview。没图 / 取不到就不画图，卡片照常出。
  const coverUrl = info?.imageUrl ?? '';
  const cover = trpc.bootstrap.linkCover.useQuery(
    { url: coverUrl, cacheOnly },
    { enabled: Boolean(coverUrl), staleTime: Number.POSITIVE_INFINITY, retry: false },
  );

  const host = hostOf(url);
  let card: CardData | null = null;
  if (info) {
    card = {
      url,
      title: info.title,
      // QQ 给的 desc 在页面没写描述时会退化成主机名，那就跟页脚重复了，不如不显示。
      desc: info.desc === host ? '' : info.desc,
      // 站点名 QQ 没给，从地址取 host。
      siteName: host,
      cover: cover.data ? linkPreviewImageUrl(cover.data) : '',
      imageKind: 'og',
    };
  } else if (preview.data) {
    const p = preview.data;
    card = {
      url: p.url,
      title: p.title,
      desc: p.desc,
      siteName: p.siteName,
      cover: p.image ? linkPreviewImageUrl(p.image) : '',
      imageKind: p.imageKind,
    };
  }

  return (
    <span ref={anchor} className="weq-link-card-layout">
      <MessageLayoutChange
        anchor={anchor}
        details={[['.weq-link-card', Boolean(card), card?.title, card?.desc, Boolean(card?.cover)]]}
        animateLayout={false}
      />
      {card ? (
        <button
          type="button"
          className="weq-ark-container weq-link-card"
          role="link"
          title={[card.title, card.desc, card.url].filter(Boolean).join('\n')}
          onClick={(event) => void openLink(card.url, event.currentTarget.ownerDocument)}
        >
          <span className="weq-ark-content">
            <span className="weq-ark-title">{card.title || card.url}</span>
            {card.cover ? (
              <>
                {card.desc ? <span className="weq-ark-desc weq-link-desc">{card.desc}</span> : null}
                <img
                  className="weq-ark-preview-big"
                  src={card.cover}
                  alt=""
                  loading="lazy"
                  style={card.imageKind === 'shot' ? { objectPosition: 'top' } : undefined}
                />
              </>
            ) : (
              <span className="weq-ark-desc weq-link-desc">{card.desc || card.url}</span>
            )}
          </span>
          <span className="weq-ark-footer">
            <Link2 size={12} className="weq-link-footer-icon" />
            <span>{card.siteName}</span>
          </span>
        </button>
      ) : null}
    </span>
  );
});
