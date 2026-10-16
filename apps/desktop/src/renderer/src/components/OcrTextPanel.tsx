/**
 * OCR 纯文本面板 —— 图片灯箱里识别完之后浮出来的那个小窗口。
 *
 *   - 标题栏可拖动（把窗口挪到不挡图的地方）；位置固定在视口内，不会被拖出屏幕；
 *   - 每段一行，正文**可选中**（想自己挑一段就挑），行尾还给一个「复制本行」；
 *   - 底部两个动作：一键复制（全部）/ 退出 OCR（收起面板 + 撤掉图上的覆盖层）。
 *
 * 面板自己 `stopPropagation` 掉 mousedown —— 灯箱遮罩是「按下就关」，不拦的话点面板
 * 会把灯箱一起关掉。视觉（深色玻璃 + 主题色）见 styles/lightbox-actions.css。
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Check, Copy, LogOut, X } from 'lucide-react';
import type { OcrBlock } from '@weq/protocol';

/** 面板与视口边缘的最小间距（拖动时的夹取边界）。 */
const EDGE = 12;
/** 面板宽度 —— 与 CSS 里的 .weq-ocr-panel 保持一致，用于夹取右/下边界。 */
const PANEL_WIDTH = 340;

export interface OcrTextPanelProps {
  blocks: OcrBlock[];
  /** 这批结果从哪条腿来的：`oidb` = 在线、`local` = 本地模型（只影响副标题文案）。 */
  source?: 'oidb' | 'local';
  /** 结果直接来自本机缓存（这次没重新识别）—— 副标题里标一下，免得好端端没转圈让人以为坏了。 */
  cached?: boolean;
  /** 退出 OCR：收起面板并撤掉图上的覆盖层。 */
  onExit(): void;
}

export function OcrTextPanel({ blocks, source, cached, onExit }: OcrTextPanelProps): ReactElement {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState(() => ({
    x: Math.max(EDGE, window.innerWidth - PANEL_WIDTH - 28),
    y: 96,
  }));
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedRow, setCopiedRow] = useState<string | null>(null);

  /** 拖动：按住标题栏移动，位置夹在同一块屏幕里（标题栏始终露着）。 */
  const onHeadDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    const panel = panelRef.current;
    const startRect = panel?.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const origin = { x: startRect?.left ?? 0, y: startRect?.top ?? 0 };
    const height = startRect?.height ?? 0;

    const onMove = (ev: MouseEvent): void => {
      const maxX = window.innerWidth - PANEL_WIDTH - EDGE;
      const maxY = window.innerHeight - height - EDGE;
      setPos({
        x: Math.min(Math.max(EDGE, origin.x + ev.clientX - startX), Math.max(EDGE, maxX)),
        y: Math.min(Math.max(EDGE, origin.y + ev.clientY - startY), Math.max(EDGE, maxY)),
      });
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, []);

  // 视口变小时把面板拉回可见范围，免得拖完再缩窗口就找不着了。
  useEffect(() => {
    const onResize = (): void => {
      setPos((prev) => ({
        x: Math.min(prev.x, Math.max(EDGE, window.innerWidth - PANEL_WIDTH - EDGE)),
        y: Math.min(prev.y, Math.max(EDGE, window.innerHeight - 120)),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  async function copy(text: string, mark: (v: boolean) => void): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      mark(true);
      window.setTimeout(() => mark(false), 1400);
    } catch {
      /* 剪贴板被系统占用时静默失败：正文本身可选中，用户还能手选 */
    }
  }

  return (
    <div
      ref={panelRef}
      className="weq-ocr-panel"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="weq-ocr-panel-head" onMouseDown={onHeadDown}>
        <span className="weq-ocr-panel-title">识别结果</span>
        <span className="weq-ocr-panel-meta">
          {blocks.length} 段 · {source === 'local' ? '本地模型' : '在线'}
          {cached ? '（缓存）' : ''} · 可拖动
        </span>
        <button
          className="weq-ocr-panel-close"
          type="button"
          onClick={onExit}
          aria-label="退出 OCR"
        >
          <X size={14} />
        </button>
      </div>

      <div className="weq-ocr-panel-body">
        {blocks.map((block) => {
          // 段落自身就能定唯一键（段落号 + 文字 + 位置）；同一段文字重复出现也不撞键。
          const rowKey = `${block.parag}|${block.text}|${block.rect.x},${block.rect.y}`;
          return (
            <div className="weq-ocr-row" key={rowKey}>
              <span className="weq-ocr-row-text">{block.text}</span>
              <button
                className="weq-ocr-row-copy"
                type="button"
                aria-label="复制本行"
                title="复制本行"
                onClick={() => void copy(block.text, (v) => setCopiedRow(v ? rowKey : null))}
              >
                {copiedRow === rowKey ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          );
        })}
      </div>

      <div className="weq-ocr-panel-foot">
        <button
          className="weq-ocr-panel-btn weq-ocr-panel-btn-primary"
          type="button"
          onClick={() => void copy(blocks.map((b) => b.text).join('\n'), setCopiedAll)}
        >
          {copiedAll ? <Check size={14} /> : <Copy size={14} />}
          {copiedAll ? '已复制' : '一键复制'}
        </button>
        <button className="weq-ocr-panel-btn" type="button" onClick={onExit}>
          <LogOut size={14} />
          退出 OCR
        </button>
      </div>
    </div>
  );
}
