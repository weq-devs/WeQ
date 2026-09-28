/**
 * 表情弹射 (elementType=27 / EMOJI_BOUNCE, QQ 内部名 FACEBUBBLE).
 *
 * QQ animates these flying across the chat; we render the emoji statically with
 * a count badge instead — the animation carries no information the badge doesn't.
 *
 * `emojiBounceId` shares the `faceId` namespace, so FaceEmoji resolves it from
 * the account's QQ NT emoji dir and already degrades to a line-art placeholder
 * when the id has no local asset. We deliberately do NOT pass `animated` — that
 * would take FaceEmoji's Lottie branch and loop the sticker forever.
 *
 * The count is parsed out of `emojiBounceTextSummary` (e.g. 「你弹射了3个[大笑]」);
 * no digits found → no badge, which is the right answer for a single bounce. The
 * badge reuses the composer panel's compact formatting (21.47亿 / 1.5万) so an
 * int32-max bounce can't stretch the corner badge across the whole row.
 */

import type { ReactElement } from 'react';
import { FaceEmoji } from './FaceEmoji';
import { formatBounceCount } from '../lib/bounceCount';

/** 大表情尺寸 —— 与贴表情（QqMessageContent 的 STICKER_SIZE）同一档。 */
const BOUNCE_SIZE = 135;

/** First run of digits in the summary text — QQ's phrasing varies by client. */
function parseCount(summary: string | undefined): number | null {
  if (!summary) return null;
  const m = summary.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n > 1 ? n : null;
}

export function QqEmojiBounce({
  emojiBounceId,
  name,
  textSummary,
  pcText,
}: {
  emojiBounceId?: number;
  name?: string;
  textSummary?: string;
  pcText?: string;
}): ReactElement {
  const summary = textSummary?.trim() || pcText?.trim() || '';
  const count = parseCount(summary);
  const label = name?.trim() || summary || '表情弹射';

  return (
    <span className="weq-emoji-bounce" title={summary || label}>
      <FaceEmoji element={{ faceId: emojiBounceId ?? 0, faceText: label }} size={BOUNCE_SIZE} />
      {count ? <span className="weq-emoji-bounce-count">×{formatBounceCount(count)}</span> : null}
    </span>
  );
}
