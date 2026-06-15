/**
 * Renders a single QQ `FaceElement` (elementType 6).
 *
 *   - The numeric `faceId` maps to a folder under `resources/emoji/<id>/`
 *     (folder name == the `id` field in `resources/emoji/emojis.json`).
 *   - Normal faces show the static APNG at `<id>/apng/<id>.png`.
 *   - Interactive faces (358 骰子, 359 石头剪刀布) carry a `diceValue` and play
 *     the matching Lottie at `<id>/lottie/<id>_<value>.json`. A "0"/missing/
 *     out-of-range value falls back to the static APNG.
 *
 * Sizing/layout (inline vs. sticker) is the caller's concern — pass `size`
 * and/or `className`. Resources stream from disk via `weq-asset://`, so
 * nothing here is bundled into the renderer build.
 */

import { useEffect, useRef, useState } from 'react';
import type { FaceElement } from '@weq/codec';
import { emojiUrl } from '@renderer/lib/resourceUrl';
import { cn } from '@renderer/lib/utils';

/** faceId → highest valid `diceValue`. Values run 1..max (e.g. dice 1..6). */
const LOTTIE_FACES: Record<number, number> = {
  358: 6, // 骰子
  359: 3, // 石头剪刀布
};

export type FaceEmojiProps = {
  element: Pick<FaceElement, 'faceId' | 'diceValue'> & { faceText?: string };
  /** Box size — number (px) or any CSS length string (e.g. "1.3em"). */
  size?: number | string;
  className?: string;
};

function toLength(size: number | string | undefined): string | undefined {
  if (size === undefined) return undefined;
  return typeof size === 'number' ? `${size}px` : size;
}

export function FaceEmoji({ element, size, className }: FaceEmojiProps) {
  const { faceId, faceText, diceValue } = element;
  const label = faceText || `[表情${faceId}]`;
  const apngSrc = emojiUrl(String(faceId), 'apng', `${faceId}.png`);
  const dim = toLength(size);
  const boxStyle = dim ? { width: dim, height: dim } : undefined;

  const lottieMax = LOTTIE_FACES[faceId];
  const diceNum = diceValue ? Number(diceValue) : 0;
  const useLottie =
    lottieMax !== undefined &&
    Number.isInteger(diceNum) &&
    diceNum >= 1 &&
    diceNum <= lottieMax;

  if (useLottie) {
    const idStr = String(faceId);
    return (
      <FaceLottie
        // Play the neutral intro (e.g. dice rolling) once, then the result.
        sources={[
          emojiUrl(idStr, 'lottie', `${faceId}.json`),
          emojiUrl(idStr, 'lottie', `${faceId}_${diceNum}.json`),
        ]}
        fallbackSrc={apngSrc}
        label={label}
        style={boxStyle}
        className={className}
      />
    );
  }

  return (
    <FaceImage src={apngSrc} label={label} style={boxStyle} className={className} />
  );
}

function FaceImage({
  src,
  label,
  style,
  className,
}: {
  src: string;
  label: string;
  style?: { width: string; height: string };
  className?: string;
}) {
  const [broken, setBroken] = useState(false);

  if (broken) {
    return (
      <span className={cn('face-emoji face-emoji-fallback', className)} title={label}>
        {label}
      </span>
    );
  }

  return (
    <img
      className={cn('face-emoji', className)}
      style={style}
      src={src}
      alt={label}
      title={label}
      draggable={false}
      onError={() => setBroken(true)}
    />
  );
}

function FaceLottie({
  sources,
  fallbackSrc,
  label,
  style,
  className,
}: {
  /** Animations played in order; the last one holds on its final frame. */
  sources: string[];
  fallbackSrc: string;
  label: string;
  style?: { width: string; height: string };
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const sourcesKey = sources.join('|');

  useEffect(() => {
    let destroyed = false;
    let anim: import('lottie-web').AnimationItem | undefined;
    setFailed(false);

    void (async () => {
      try {
        // `lottie_light` drops the expression evaluator (which uses `eval`),
        // keeping us within CSP `script-src 'self'`. The dice/rps animations
        // carry no expressions, so nothing is lost.
        const [{ default: lottie }, ...payloads] = await Promise.all([
          import('lottie-web/build/player/lottie_light'),
          ...sources.map(async (src) => {
            const res = await fetch(src);
            if (!res.ok) throw new Error(`lottie fetch ${res.status}`);
            return (await res.json()) as unknown;
          }),
        ]);
        if (destroyed || !containerRef.current) return;

        // Play each clip in turn; the final clip stops on its last frame.
        const playAt = (index: number) => {
          if (destroyed || !containerRef.current) return;
          const isLast = index === payloads.length - 1;
          anim?.destroy();
          const current = lottie.loadAnimation({
            container: containerRef.current,
            renderer: 'svg',
            loop: false,
            autoplay: true,
            animationData: payloads[index],
          });
          anim = current;
          if (!isLast) {
            current.addEventListener('complete', () => playAt(index + 1));
          }
        };
        playAt(0);
      } catch {
        if (!destroyed) setFailed(true);
      }
    })();

    return () => {
      destroyed = true;
      anim?.destroy();
    };
  }, [sourcesKey]);

  if (failed) {
    return (
      <FaceImage src={fallbackSrc} label={label} style={style} className={className} />
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn('face-emoji face-emoji-lottie', className)}
      style={style}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}
