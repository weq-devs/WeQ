/**
 * 十六进制转储 + 复制按钮。
 *
 * 从 `CapturePanel.tsx` 抽出来的：UDP 抓包面板要用同一份实现，抽出来避免两处
 * 漂移。样式类名沿用 `.weq-cap-*`（两边共用同一套样式）。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { Check, Copy } from 'lucide-react';
import { useRenderDocument } from '../lib/renderDocument';
import { useToast } from './Toast';

/** 默认渲染的字节数；超过可用「显示全部」展开。 */
export const HEX_PREVIEW_BYTES = 2048;

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function HexDump({
  bytes,
  copyText,
}: {
  bytes: Uint8Array;
  copyText: string;
}): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? bytes : bytes.subarray(0, HEX_PREVIEW_BYTES);
  const rows: ReactElement[] = [];
  for (let off = 0; off < shown.length; off += 16) {
    const slice = shown.subarray(off, off + 16);
    const hex = Array.from(slice)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    const ascii = Array.from(slice)
      .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
      .join('');
    rows.push(
      <div className="weq-cap-hx-line" key={off}>
        <span className="weq-cap-hx-off">{off.toString(16).padStart(8, '0')}</span>
        <span className="weq-cap-hx-hex">{hex}</span>
        <span className="weq-cap-hx-ascii">{ascii}</span>
      </div>,
    );
  }
  return (
    <div className="weq-cap-hexdump">
      <div className="weq-cap-hexdump-body">{rows}</div>
      <div className="weq-cap-hexdump-foot">
        <span>
          {bytes.length === 0
            ? '空'
            : showAll
              ? `已显示全部 ${fmtBytes(bytes.length)}`
              : `前 ${Math.min(bytes.length, HEX_PREVIEW_BYTES)} B / 共 ${fmtBytes(bytes.length)}`}
        </span>
        {!showAll && bytes.length > HEX_PREVIEW_BYTES ? (
          <button type="button" className="weq-cap-more" onClick={() => setShowAll(true)}>
            显示全部
          </button>
        ) : null}
        <CopyHex text={copyText} disabled={bytes.length === 0} />
      </div>
    </div>
  );
}

/** 复制 hex 文本的小按钮（带 1.4s 的已复制反馈）。 */
export function CopyHex({ text, disabled }: { text: string; disabled?: boolean }): ReactElement {
  const document = useRenderDocument();
  const view = useMemo(() => document.defaultView ?? window, [document]);
  const timer = useRef<number | null>(null);
  const alive = useRef(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current !== null) view.clearTimeout(timer.current);
    };
  }, [view]);
  return (
    <button
      type="button"
      className="weq-cap-iconbtn"
      title="复制 hex"
      disabled={disabled}
      onClick={() => {
        const clipboard = view.navigator.clipboard;
        if (!clipboard) {
          useToast
            .getState()
            .push({ tone: 'error', title: '复制失败', detail: '当前窗口不支持剪贴板' });
          return;
        }
        void clipboard
          .writeText(text)
          .then(() => {
            if (!alive.current || view.closed) return;
            setDone(true);
            if (timer.current !== null) view.clearTimeout(timer.current);
            timer.current = view.setTimeout(() => {
              timer.current = null;
              setDone(false);
            }, 1400);
          })
          .catch((error) => {
            if (alive.current && !view.closed)
              useToast.getState().push({ tone: 'error', title: '复制失败', detail: errMsg(error) });
          });
      }}
    >
      {done ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
