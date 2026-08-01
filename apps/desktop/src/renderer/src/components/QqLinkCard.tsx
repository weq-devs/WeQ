/**
 * 链接卡片 —— 一条消息只有一个裸链接时，把它渲染成「标题 + 描述 + 封面 + 站点」。
 *
 * 数据由主进程的 LinkPreviewService 抓（og/twitter meta，公众号另走 msg_* 内联变量），
 * 那边带着 SSRF 闸门和内容类型白名单；这里只负责画，以及在抓取失败/未开启时安静地
 * 退回成一条普通的蓝色链接。
 *
 * 视觉沿用 ARK 卡片那一套 class（weq-ark-*），因为它们在聊天流里已经是「卡片」的既定
 * 语言，没必要再造一套。
 */

import { memo, type ReactElement } from 'react';
import { Link2 } from 'lucide-react';
import { trpc } from '../trpc/client';
import { linkPreviewImageUrl } from '../lib/resourceUrl';
import { openLink } from '../lib/linkify';

export const QqLinkCard = memo(function QqLinkCard({ url }: { url: string }): ReactElement {
  // 结果在主进程按 URL 落盘缓存，所以这里放心地按 url 做 query key；抓取失败返回
  // null（短 TTL 内不再重试），此时退回成一条普通链接。
  const preview = trpc.bootstrap.linkPreview.useQuery(
    { url },
    { staleTime: Number.POSITIVE_INFINITY, retry: false },
  );
  const data = preview.data;

  if (!data) {
    return (
      <span className="qq-link-fallback">
        <button type="button" className="qq-link" onClick={() => openLink(url)}>
          {url}
        </button>
      </span>
    );
  }

  const cover = data.image ? linkPreviewImageUrl(data.image) : '';
  return (
    <div
      className="weq-ark-container weq-link-card"
      role="link"
      title={data.url}
      onClick={() => openLink(data.url)}
    >
      <div className="weq-ark-content">
        <div className="weq-ark-title">{data.title || data.url}</div>
        {cover ? (
          <>
            {data.desc ? <div className="weq-ark-desc weq-link-desc">{data.desc}</div> : null}
            <img
              className="weq-ark-preview-big"
              src={cover}
              alt=""
              loading="lazy"
              // 截图是整页首屏，按顶部对齐才能看到标题区；og 图则按常规裁切。
              style={data.imageKind === 'shot' ? { objectPosition: 'top' } : undefined}
            />
          </>
        ) : (
          <div className="weq-ark-desc weq-link-desc">{data.desc || data.url}</div>
        )}
      </div>
      <div className="weq-ark-footer">
        <Link2 size={12} className="weq-link-footer-icon" />
        <span>{data.siteName}</span>
      </div>
    </div>
  );
});
