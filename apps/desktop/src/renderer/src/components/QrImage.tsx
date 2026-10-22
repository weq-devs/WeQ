/**
 * Renders a URL as a QR code SVG.
 *
 * Uses `qrcode` (npm) — small, no extra deps, returns a self-contained
 * SVG string we can inject with `dangerouslySetInnerHTML`. The SVG is
 * pure markup (no scripts), so the standard React lint warning about
 * setting raw HTML doesn't apply to a real safety issue here.
 *
 * Re-renders when `url` changes; nothing else.
 */

import QRCode from 'qrcode';
import { useEffect, useState, type ReactElement } from 'react';
import '../styles/qr-login.css';

export function QrImage({ url, size = 192 }: { url: string; size?: number }): ReactElement {
  const [result, setResult] = useState<{
    url: string;
    size: number;
    svg?: string;
    error?: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(url, { type: 'svg', margin: 1, width: size })
      .then((s) => {
        if (!cancelled) setResult({ url, size, svg: s });
      })
      .catch((e: unknown) => {
        if (!cancelled) setResult({ url, size, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [url, size]);

  // 目标或尺寸变化后，旧图与旧错误都不能作为当前请求的结果。
  const current = result?.url === url && result.size === size ? result : null;
  if (current?.error)
    return (
      <div className="weq-qr-render-error" role="alert">
        二维码生成失败：{current.error}
      </div>
    );
  if (!current?.svg)
    return (
      <div role="status" aria-label="正在生成二维码" style={{ width: size, height: size }}>
        …
      </div>
    );
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(current.svg)}`}
      alt="二维码"
      style={{ width: size, height: size }}
    />
  );
}
