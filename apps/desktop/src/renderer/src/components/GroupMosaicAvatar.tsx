/**
 * 克隆群聊的合成头像：把成员头像拼成九宫格。
 *
 * 会话列表、克隆工作区左栏、对话头部、导出会话列表统一走这里，避免各处各写一套
 * 拼格逻辑。布局见 GroupMosaicAvatar.shared。
 */

import type { ReactElement } from 'react';
import { Users } from 'lucide-react';
import { qqAvatarUrl } from './QqAvatar.shared';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { useAvatarImage } from '../hooks/useAvatarImage';
import { useRenderDocument, resourceForRenderDocument } from '../lib/renderDocument';
import '../styles/group-mosaic-avatar.css';
import { mosaicLayout } from './GroupMosaicAvatar.shared';

function MosaicImg({ uin }: { uin: string }): ReactElement {
  const ownerDocument = useRenderDocument();
  const raw = useAvatarUrl(qqAvatarUrl(uin));
  // 导出 / 合成记录等独立 document 里，本地桥是相对路径，得按主文档 base 补全。
  const src = raw ? resourceForRenderDocument(raw, ownerDocument) : null;
  const image = useAvatarImage(src);
  if (!src || image.failed)
    return <span ref={image.observeRef} className="weq-group-mosaic-fallback" aria-hidden />;
  return (
    <img
      key={image.retryKey}
      ref={image.ref}
      src={image.src}
      alt=""
      loading="lazy"
      onLoad={image.onLoad}
      onError={image.onError}
    />
  );
}

export function GroupMosaicAvatar({
  uins,
  size = 40,
  max = 9,
  shape = 'circle',
  className = '',
}: {
  uins: readonly string[];
  size?: number | string;
  /** 最多取几张成员头像（小尺寸头像可传 4，避免每格糊成色块）。 */
  max?: number;
  shape?: 'circle' | 'square';
  className?: string;
}): ReactElement {
  const unique = [...new Set(uins.filter(Boolean))].slice(0, max);
  if (unique.length === 0) {
    return (
      <span
        className={`weq-group-mosaic is-empty${shape === 'square' ? ' is-square' : ''} ${className}`}
        style={{ width: size, height: size }}
        aria-hidden
      >
        <Users size={typeof size === 'number' ? Math.round(size * 0.5) : 20} strokeWidth={1.7} />
      </span>
    );
  }
  const { columns, rows, columnSpans } = mosaicLayout(unique.length);
  // 3 人时第一张跨两行，左侧一整列、右侧上下两格 —— 否则 2×2 会空掉一格。
  const lead = unique.length === 3;
  return (
    <span
      className={`weq-group-mosaic${shape === 'square' ? ' is-square' : ''} ${className}`}
      style={{
        width: size,
        height: size,
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
      aria-hidden
    >
      {unique.slice(0, lead ? 3 : columns * rows).map((uin, index) => (
        <span
          key={uin}
          className="weq-group-mosaic-cell"
          style={{
            gridRow: lead && index === 0 ? 'span 2' : undefined,
            gridColumn: columnSpans ? `span ${columnSpans[index]}` : undefined,
          }}
        >
          <MosaicImg uin={uin} />
        </span>
      ))}
    </span>
  );
}
