/**
 * Renders a single QQ `FaceElement` (elementType 6).
 *
 *   - The numeric `faceId` maps to a folder named after the id, served from the
 *     logged-in account's QQ NT emoji dir (`<id>/apng/<id>.png`,
 *     `<id>/lottie/<id>.json`) via `weq-asset://emoji/...` — see
 *     src/main/resource_protocol.ts.
 *   - Inline faces (small, `animated` unset) show the static APNG.
 *   - Big faces (`animated`) prefer the looping Lottie at `<id>/lottie/<id>.json`
 *     when present, falling back to the static APNG when the dir has none.
 *   - Interactive faces (114 篮球, 358 骰子, 359 石头剪刀布) carry a `diceValue` and
 *     play an intro Lottie then the result clip at `<id>/lottie/<id>_<value>.json`.
 *     A "0"/missing/out-of-range value falls back to the static APNG.
 *   - subType=5 poke faces (戳一戳) render a static PNG from the bundled
 *     `resources/pokeEmoji/<faceId>.png` set (ids 0-6; out-of-range → 0).
 *
 * Sizing/layout (inline vs. sticker) is the caller's concern — pass `size`
 * and/or `className`. Resources stream from disk via `weq-asset://`, so
 * nothing here is bundled into the renderer build.
 */

import { useEffect, useRef, useState } from 'react';
import type { FaceElement } from '@weq/codec';
import { emojiUrl, resourceUrl } from '@renderer/lib/resourceUrl';
import { cn } from '@renderer/lib/utils';
import { UNICODE_FACE_MAP } from './unicodeFaceMap';

/**
 * Interactive faces. `max` = highest valid `diceValue` (values run 1..max);
 * `introPlays` = how many times the intro clip repeats before the result clip.
 * QQ shuffles 石头剪刀布 twice before revealing, but tumbles the 骰子 once.
 */
const LOTTIE_FACES: Record<number, { max: number; introPlays: number }> = {
  114: { max: 6, introPlays: 1 }, // 篮球
  358: { max: 6, introPlays: 1 }, // 骰子
  359: { max: 3, introPlays: 2 }, // 石头剪刀布
};

/** subType=5 poke faces stream from resources/pokeEmoji/<faceId>.png (ids 0-6). */
const POKE_FACE_SUBTYPE = 5;
const POKE_FACE_MAX_ID = 6;

export type FaceEmojiProps = {
  element: Pick<FaceElement, 'faceId' | 'diceValue'> & {
    faceText?: string;
    subType?: number;
  };
  /** Box size — number (px) or any CSS length string (e.g. "1.3em"). */
  size?: number | string;
  /**
   * Big/sticker rendering: prefer the looping Lottie animation when the emoji
   * dir has one, falling back to the static APNG. Inline faces leave this unset.
   */
  animated?: boolean;
  className?: string;
  /** Whether the message sender is the current user (for mirroring poke faces). */
  isSender?: boolean;
};

function toLength(size: number | string | undefined): string | undefined {
  if (size === undefined) return undefined;
  return typeof size === 'number' ? `${size}px` : size;
}

export function FaceEmoji({ element, size, animated, className, isSender = true }: FaceEmojiProps) {
  const { faceId, faceText, diceValue, subType } = element;
  const label = faceText || `[表情${faceId}]`;
  const dim = toLength(size);
  const boxStyle = dim ? { width: dim, height: dim } : undefined;

  // Unicode 字符表情（emoji.db base_sys_emoji_table 中 81214 非 0）：faceId 就是
  // emoji 的 Unicode code point，没有本地图片资源（`<id>/apng/<id>.png` 不存在），
  // 必须直接按字符渲染，否则只会回退成 `[表情xxx]`。faceElement 与贴表情
  // （SetEmojiReactions 复用本组件）都经此分支。
  const unicodeGlyph = UNICODE_FACE_MAP[faceId];
  if (unicodeGlyph) {
    return (
      <span
        className={cn('face-emoji-unicode', className)}
        style={{
          fontSize: dim ?? '1.25em',
          lineHeight: 1,
          display: 'inline-block',
          verticalAlign: dim ? 'middle' : '-0.15em',
          userSelect: 'none',
        }}
        title={label}
        role="img"
        aria-label={label}
      >
        {unicodeGlyph}
      </span>
    );
  }

  const idStr = String(faceId);
  const apngSrc = emojiUrl(idStr, 'apng', `${faceId}.png`);

  // subType=5 poke faces: static PNG from the bundled pokeEmoji set. Ids run
  // 0-6; anything out of range falls back to 0.
  if (subType === POKE_FACE_SUBTYPE) {
    const pokeId = Number.isInteger(faceId) && faceId >= 0 && faceId <= POKE_FACE_MAX_ID ? faceId : 0;
    return (
      <FaceImage
        src={resourceUrl('pokeEmoji', `${pokeId}.png`)}
        label={label}
        style={boxStyle}
        className={cn(className, !isSender && 'face-poke-mirror')}
      />
    );
  }

  const interactive = LOTTIE_FACES[faceId];
  const diceNum = diceValue ? Number(diceValue) : 0;
  const useInteractive =
    interactive !== undefined &&
    Number.isInteger(diceNum) &&
    diceNum >= 1 &&
    diceNum <= interactive.max;

  if (useInteractive) {
    // Repeat the neutral intro (e.g. shuffle) introPlays times, then the result
    // clip, which holds on its final frame.
    const intro = emojiUrl(idStr, 'lottie', `${faceId}.json`);
    const sources = [
      ...Array.from({ length: interactive.introPlays }, () => intro),
      emojiUrl(idStr, 'lottie', `${faceId}_${diceNum}.json`),
    ];
    return (
      <FaceLottie
        sources={sources}
        fallbackSrc={apngSrc}
        label={label}
        style={boxStyle}
        className={className}
      />
    );
  }

  // Big faces prefer the looping Lottie when the dir has one; fetch failure
  // (no lottie for this face) falls back to the static APNG.
  if (animated) {
    return (
      <FaceLottie
        sources={[emojiUrl(idStr, 'lottie', `${faceId}.json`)]}
        loop
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
  loop = false,
  fallbackSrc,
  label,
  style,
  className,
}: {
  /** Animations played in order; the last one holds on its final frame. */
  sources: string[];
  /** Loop the (single) animation continuously instead of stopping at the end. */
  loop?: boolean;
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
            // Only the final clip may loop (used by big animated stickers); the
            // intro→result interactive sequence never loops.
            loop: isLast ? loop : false,
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
  }, [sourcesKey, loop]);

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
