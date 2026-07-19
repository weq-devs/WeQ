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

export function QrImage({ url, size = 192 }: { url: string; size?: number }): ReactElement {
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toString(url, { type: 'svg', margin: 1, width: size })
      .then((s) => {
        if (!cancelled) setSvg(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [url, size]);

  if (error) return <div style={{ color: 'crimson' }}>QR render failed: {error}</div>;
  if (!svg) return <div style={{ width: size, height: size }}>…</div>;
  return (
    <img
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
      alt="QR code"
      style={{ width: size, height: size }}
    />
  );
}
