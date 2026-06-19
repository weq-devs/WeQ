/**
 * Renders a `call` element (语音 / 视频 / 屏幕共享 / 远程协作) as an icon + the
 * pre-formatted `callSummary` line. Drawn inside the normal bubble (no chrome
 * takeover) — that's what the user asked for: an icon glyph and the summary,
 * with failed/rejected/missed calls in red.
 *
 * The kind comes from `callMethod` (the CallType enum: 1 voice, 2 video, 3
 * screen share, 5 remote assist); the connected/failed split comes from
 * `subType` (the CallSubType enum). We keep both as plain numbers and use a
 * small constant set for the accepted values so we don't have to import the
 * codec enum from the renderer.
 */

import type { ReactElement } from 'react';
import { Phone, Video, MonitorUp, LaptopMinimal, PhoneCall } from 'lucide-react';

// CallSubType values that mean "the call actually connected". Every other
// value (rejected by either side, handled on another device, plain failure)
// gets the red treatment. See packages/codec/src/element/types.ts.
const CONNECTED_SUBTYPES = new Set<number>([
  2, // VIDEO_ACCEPTED
  7, // VOICE_ACCEPTED
  19, // SCREEN_SHARE_ACCEPTED
  33, // REMOTE_ASSIST_ACCEPTED
]);

// CallType (callMethod) → display label + lucide icon.
const CALL_KIND: Record<number, { label: string; Icon: typeof Phone }> = {
  1: { label: '语音通话', Icon: Phone },
  2: { label: '视频通话', Icon: Video },
  3: { label: '屏幕共享', Icon: MonitorUp },
  5: { label: '远程协作', Icon: LaptopMinimal },
};

export function QqCall({
  callMethod,
  subType,
  callSummary,
}: {
  callMethod: unknown;
  subType: unknown;
  callSummary: unknown;
}): ReactElement {
  const method = Number(callMethod);
  const sub = Number(subType);
  const kind = CALL_KIND[method] ?? { label: '通话', Icon: PhoneCall };
  const Icon = kind.Icon;

  // Summary lines are pre-localized by QQ — join them with " · " so multi-line
  // summaries (e.g. "通话时长 00:12 · 已结束") read as one line in the bubble.
  const summary = Array.isArray(callSummary)
    ? (callSummary as unknown[]).filter((s) => typeof s === 'string' && s.length > 0).join(' · ')
    : '';
  const text = summary || kind.label;

  const connected = CONNECTED_SUBTYPES.has(sub);

  return (
    <span className={`weq-call-card${connected ? '' : ' weq-call-failed'}`}>
      <Icon className="weq-call-icon" size={16} strokeWidth={2} aria-hidden />
      <span className="weq-call-text">{text}</span>
    </span>
  );
}
