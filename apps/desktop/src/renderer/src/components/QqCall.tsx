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
 *
 * WeQ 自己录的通话音频挂在旁边（`recordingForMessage`）。匹配是 best-effort：
 * 通话结束后 QQ 客户端才会写这条 call 消息，双方都用 WeQ 时可能压根没有它 ——
 * 查不到就只渲染原来那行摘要。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Phone,
  Video,
  MonitorUp,
  LaptopMinimal,
  PhoneCall,
  Radio,
  Pause,
  Play,
} from 'lucide-react';
import { trpc } from '../trpc/client';
import { recordingUrl } from '../lib/resourceUrl';
import type { CallConv } from './QqMessageContent';

// CallSubType values that mean "the call actually connected". Every other
// value (rejected by either side, handled on another device, plain failure)
// gets the red treatment. See packages/codec/src/element/types.ts.
//
// 群聊的「发起」（1/26）也算非失败 —— 那是一通电话的开头，不是未接来电。群聊的
// 「已结束」（16/25）走灰条（GroupCallEndedMessage），走不到这里，但导出/转发等
// 旁路会，所以一并列上。
const CONNECTED_SUBTYPES = new Set<number>([
  1, // GROUP_VOICE_STARTED
  2, // VIDEO_ACCEPTED
  5, // VIDEO_ACCEPTED_LEGACY — 旧版客户端的视频接通
  7, // VOICE_ACCEPTED
  16, // GROUP_VOICE_ENDED
  19, // SCREEN_SHARE_ACCEPTED
  25, // GROUP_VIDEO_ENDED
  26, // GROUP_VIDEO_STARTED
  27, // GROUP_CLASSROOM_STARTED
  29, // GROUP_CLASSROOM_ENDED
  33, // REMOTE_ASSIST_ACCEPTED
]);

// subType 优先覆盖 callMethod 选图标（用于 callMethod 未知的新类型）。
const SUBTYPE_ICON: Record<number, typeof Phone> = {
  27: Radio, // GROUP_CLASSROOM_STARTED
  29: Radio, // GROUP_CLASSROOM_ENDED
};

// CallType (callMethod) → display label + lucide icon. 0 是群通话结束提示，
// QQ 不在这条消息里区分语音/视频（只能看 subType），所以用中性的话筒图标。
const CALL_KIND: Record<number, { label: string; Icon: typeof Phone }> = {
  0: { label: '通话已结束', Icon: PhoneCall },
  1: { label: '语音通话', Icon: Phone },
  2: { label: '视频通话', Icon: Video },
  3: { label: '屏幕共享', Icon: MonitorUp },
  5: { label: '远程协作', Icon: LaptopMinimal },
};

export function QqCall({
  callMethod,
  subType,
  callSummary,
  sendTimeMs = 0,
  msgId = '',
  conv = null,
}: {
  callMethod: unknown;
  subType: unknown;
  callSummary: unknown;
  /** 消息发送时刻（毫秒）—— 录音匹配的时间窗依据。 */
  sendTimeMs?: number;
  /** 消息 id —— 录音匹配的精确键。 */
  msgId?: string;
  /** 会话身份；为 null 时不查录音。 */
  conv?: CallConv | null;
}): ReactElement {
  const method = Number(callMethod);
  const sub = Number(subType);
  const kind = CALL_KIND[method] ?? { label: '通话', Icon: PhoneCall };
  const Icon = SUBTYPE_ICON[sub] ?? kind.Icon;

  // Summary lines are pre-localized by QQ — join them with " · " so multi-line
  // summaries (e.g. "通话时长 00:12 · 已结束") read as one line in the bubble.
  const summary = Array.isArray(callSummary)
    ? (callSummary as unknown[]).filter((s) => typeof s === 'string' && s.length > 0).join(' · ')
    : '';
  const text = summary || kind.label;

  const connected = CONNECTED_SUBTYPES.has(sub);
  const recording = useCallRecording(conv, sendTimeMs, msgId, connected);

  return (
    <span className={`weq-call-card${connected ? '' : ' weq-call-failed'}`}>
      <Icon className="weq-call-icon" size={16} strokeWidth={2} aria-hidden />
      <span className="weq-call-text">{text}</span>
      {recording ? (
        <CallRecordingButton id={recording.id} durationSec={recording.durationSec} />
      ) : null}
    </span>
  );
}

/**
 * 查这条消息有没有对应的录音。
 *
 * 只在**接通**的通话上查：未接 / 被拒的那条不可能有录音，省一次 IPC。`staleTime`
 * 给一分钟 —— 录音在通话结束时就已经写进索引，之后不会变；唯一会变的是
 * 「这次查询顺手把 msgId 认领给这条录音」，那不影响展示。
 */
function useCallRecording(
  conv: CallConv | null,
  sendTimeMs: number,
  msgId: string,
  connected: boolean,
) {
  const enabled = Boolean(conv?.conv) && connected && sendTimeMs > 0;
  const query = trpc.call.recordingForMessage.useQuery(
    {
      kind: conv?.kind ?? 'c2c',
      conv: conv?.conv ?? '',
      sendTimeMs,
      ...(msgId ? { msgId } : {}),
    },
    { enabled, staleTime: 60_000, refetchOnWindowFocus: false },
  );
  return query.data ?? null;
}

/** 气泡里的播放按钮：与语音消息同一套交互（点一下播、再点停）。 */
function CallRecordingButton({ id, durationSec }: { id: string; durationSec: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    setPlaying(false);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, [id]);

  const toggle = () => {
    let audio = audioRef.current;
    if (!audio) {
      audio = new Audio(recordingUrl(id));
      audio.onended = () => setPlaying(false);
      audio.onerror = () => setPlaying(false);
      audioRef.current = audio;
    }
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    void audio
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false));
  };

  return (
    <button
      type="button"
      className={`weq-call-recording-play${playing ? ' is-playing' : ''}`}
      onClick={toggle}
      title={`播放通话录音（${formatDuration(durationSec)}）`}
      aria-label="播放通话录音"
      aria-pressed={playing}
    >
      {playing ? <Pause size={12} /> : <Play size={12} />}
    </button>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
