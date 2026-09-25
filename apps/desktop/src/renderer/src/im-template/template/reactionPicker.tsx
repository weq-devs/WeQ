// @ts-nocheck
/**
 * 贴表情（表情回应）选择面板。
 *
 * 只列 QQ 系统小黄脸 + 字符表情 —— 这两类才能作为 OIDB 0x9082 的 `code`
 * （1–3 位 = 小黄脸 id，更长 = Unicode 码点）。商城 / 收藏 / GIF 表情不支持回应，
 * 不进这个面板。数据复用输入框表情面板的同一份 `emojiPanel.overview` 查询。
 */
import { Smile } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { trpc } from '../../trpc/client';
import { cn } from './classNames';
import { systemFaceItem, unicodeFaceItem } from './emojiPacks';

type ReactionCell = {
  key: string;
  title: string;
  /** 回应 code：系统表情 = faceId，字符表情 = Unicode 码点。 */
  code: string;
  item: ReturnType<typeof systemFaceItem>;
};

export function ReactionPicker({
  anchor,
  onSelect,
  onClose,
}: {
  anchor: { x: number; y: number };
  /** 选中一枚表情，参数是可直接交给 0x9082 的 code。 */
  onSelect: (code: string) => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const overview = trpc.account.emojiPanel.overview.useQuery(undefined, { staleTime: 30_000 });
  const faces = overview.data?.faces ?? [];

  const cells = useMemo<ReactionCell[]>(() => {
    const out: ReactionCell[] = [];
    for (const group of faces) {
      for (const it of group.items) {
        if (group.unicode) {
          const glyph = it.glyph || it.id;
          const point = glyph ? glyph.codePointAt(0) : undefined;
          if (point == null) continue;
          out.push({
            key: `u-${it.id}`,
            title: it.desc,
            code: String(point),
            item: unicodeFaceItem(glyph, it.desc),
          });
        } else {
          out.push({
            key: `f-${it.id}`,
            title: it.desc,
            code: String(it.id),
            item: systemFaceItem(it.id, it.desc),
          });
        }
      }
    }
    return out;
  }, [faces]);

  // 同款 fixed 定位钳制。
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    el.style.left = `${Math.min(
      Math.max(anchor.x, margin),
      Math.max(margin, window.innerWidth - rect.width - margin),
    )}px`;
    el.style.top = `${Math.min(
      Math.max(anchor.y, margin),
      Math.max(margin, window.innerHeight - rect.height - margin),
    )}px`;
  }, [anchor.x, anchor.y]);

  useEffect(() => {
    function closeFromOutside(event: globalThis.MouseEvent) {
      const target = event.target;
      if (target instanceof Node && panelRef.current?.contains(target)) return;
      onClose();
    }
    function closeOnEscape(event: globalThis.KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', closeFromOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeFromOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  return (
    <div
      ref={panelRef}
      className={cn('reaction-picker')}
      style={{ left: anchor.x, top: anchor.y }}
      role="dialog"
      aria-label="贴表情"
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className={cn('reaction-picker-head')}>贴表情</div>
      <div className={cn('reaction-picker-body')}>
        {overview.isLoading && cells.length === 0 ? (
          <div className={cn('emoji-state')}>加载中…</div>
        ) : cells.length === 0 ? (
          <div className={cn('emoji-state')}>没有可用的表情</div>
        ) : (
          <div className={cn('reaction-picker-grid')}>
            {cells.map((cell) => (
              <button
                key={cell.key}
                type="button"
                title={cell.title}
                className={cn('reaction-picker-cell')}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(cell.code)}
              >
                {cell.item.glyph ? (
                  <span className={cn('emoji-glyph')}>{cell.item.glyph}</span>
                ) : cell.item.src ? (
                  <img src={cell.item.src} alt={cell.title} draggable={false} />
                ) : (
                  <Smile size={20} strokeWidth={1.5} />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
