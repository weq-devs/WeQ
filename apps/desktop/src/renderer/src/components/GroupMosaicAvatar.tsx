/**
 * 克隆群聊的合成头像：把成员头像拼成九宫格。
 *
 * 会话列表、克隆工作区左栏、对话头部、导出会话列表统一走这里，避免各处各写一套
 * 拼格逻辑。布局按人数铺满，不留空格：
 *   1 人 → 单图；2 人 → 左右各半；3 人 → 左一占满整列 + 右侧上下两格；
 *   4 人 → 2×2；5 人以上 → 三列（最多 9 格）。
 * 5/7/8 人时末行按人数自然留白，与 QQ 群头像一致。
 */

import { useState, type ReactElement } from 'react';
import { Users } from 'lucide-react';
import { qqAvatarUrl } from './QqAvatar';
import { useAvatarUrl } from '../hooks/useAvatarUrl';
import { useRenderDocument, resourceForRenderDocument } from '../lib/renderDocument';
import '../styles/group-mosaic-avatar.css';

/** 单个格子的列/行数。导出成纯函数方便单测覆盖 2/3/4 这些少人数情况。 */
export function mosaicLayout(count: number): { columns: number; rows: number } {
  if (count <= 1) return { columns: 1, rows: 1 };
  if (count === 2) return { columns: 2, rows: 1 };
  if (count <= 4) return { columns: 2, rows: 2 };
  return { columns: 3, rows: Math.min(3, Math.ceil(count / 3)) };
}

function MosaicImg({ uin }: { uin: string }): ReactElement {
  const ownerDocument = useRenderDocument();
  const raw = useAvatarUrl(qqAvatarUrl(uin));
  const [failed, setFailed] = useState(false);
  // 导出 / 合成记录等独立 document 里，本地桥是相对路径，得按主文档 base 补全。
  const src = raw ? resourceForRenderDocument(raw, ownerDocument) : null;
  if (!src || failed) return <span className="weq-group-mosaic-fallback" aria-hidden />;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function GroupMosaicAvatar({
  uins,
  size = 40,
  max = 9,
  shape = 'circle',
  className = '',
}: {
  uins: readonly string[];
  size?: number;
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
        <Users size={Math.round(size * 0.5)} strokeWidth={1.7} />
      </span>
    );
  }
  const { columns, rows } = mosaicLayout(unique.length);
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
          style={lead && index === 0 ? { gridRow: 'span 2' } : undefined}
        >
          <MosaicImg uin={uin} />
        </span>
      ))}
    </span>
  );
}
