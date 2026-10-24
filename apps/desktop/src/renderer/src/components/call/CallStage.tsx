/**
 * 通话舞台：背景 / 光环 / 头像 / 名字 / 状态 / 波形。
 *
 * `peers` 现在是长度为 1 的数组 —— 形状先按**多人通话**定好，将来加网格布局时
 * 只改这一个组件，窗口与控件都不用动。视频通话的渲染层将来插在头像的位置
 * （`peers[].video` 非空就画视频，否则画头像）。
 */

import { useMemo } from 'react';
import { Loader2, PhoneIncoming } from 'lucide-react';
import { dressUrl } from '../../lib/resourceUrl';
import { CALL_WAVE_BAR_COUNT, callWaveBar, callWaveShape } from '../../lib/callWave';

/** 一个通话参与者。多人通话时数组里会有多个。 */
export interface CallPeer {
  uin: string;
  name: string;
  avatarUrl: string;
  /** 该参与者的实时响度（0..1）。 */
  level: number;
}

export type CallState =
  | 'idle'
  | 'calling'
  | 'ringing'
  | 'connecting'
  | 'connected'
  | 'ending'
  | 'ended'
  | 'failed';

/**
 * 波形柱的静态形状：中间高两边低。
 *
 * 预先算好而不是在渲染里 `Math.sin`，一是避免每帧重算，二是给每根柱子一个
 * 稳定的 key（用下标当 key 会让 lint 报错，且柱子的顺序本身不会变）。
 */
const WAVE_BARS = Array.from({ length: CALL_WAVE_BAR_COUNT }, (_, index) => ({
  id: `bar-${index}`,
  shape: callWaveShape(index),
}));

export interface CallStageProps {
  peers: CallPeer[];
  state: CallState;
  /** 状态文案（时长 / 阶段）。 */
  status: string;
  /** 本端实时响度。 */
  selfLevel: number;
  /** 背景静态图；空表示没设。 */
  backgroundUrl: string;
  /** 背景动态版；非空时优先播。 */
  backgroundVideoUrl: string;
  /** 背景素材加载失败时由父组件置位，退回无背景态。 */
  backdropFailed: boolean;
  onBackdropError: () => void;
}

export function CallStage({
  peers,
  state,
  status,
  selfLevel,
  backgroundUrl,
  backgroundVideoUrl,
  backdropFailed,
  onBackdropError,
}: CallStageProps) {
  const live = state === 'connected';
  const ringing = state === 'calling' || state === 'ringing';
  const hasBackdrop = !backdropFailed && Boolean(backgroundUrl || backgroundVideoUrl);
  const primary = peers[0];
  const peerLevel = primary?.level ?? 0;

  const initialLetter = useMemo(
    () => (primary?.name || primary?.uin || '?').slice(0, 1).toUpperCase(),
    [primary?.name, primary?.uin],
  );

  return (
    <>
      {/* 个性化通话背景：视频优先（这类装扮本来就是动图），静帧兜底。 */}
      {hasBackdrop ? (
        <div className="weq-call-backdrop-media" aria-hidden="true">
          {backgroundVideoUrl && !backdropFailed ? (
            <video
              src={dressUrl(backgroundVideoUrl)}
              autoPlay
              loop
              muted
              playsInline
              onError={onBackdropError}
            />
          ) : backgroundUrl && !backdropFailed ? (
            <img src={dressUrl(backgroundUrl)} alt="" onError={onBackdropError} />
          ) : null}
        </div>
      ) : null}

      {/* 呼吸光环：接通后跟随对端响度 */}
      <div className="weq-call-halo" style={{ ['--peer-level' as string]: peerLevel }} />

      <div className="weq-call-avatar">
        {primary?.avatarUrl ? (
          <img src={primary.avatarUrl} alt="" draggable={false} />
        ) : (
          <span className="weq-call-avatar-fallback">{initialLetter}</span>
        )}
      </div>

      <div className="weq-call-name">{primary?.name || primary?.uin}</div>
      <div className={`weq-call-status${live ? ' is-live' : ''}`}>
        {ringing ? <Loader2 size={14} className="weq-call-spin" /> : null}
        {live ? <PhoneIncoming size={14} /> : null}
        <span>{status}</span>
      </div>

      {/* 波形：两排细柱，左本端右对端 */}
      <div className={`weq-call-wave${live ? ' is-visible' : ''}`} aria-hidden="true">
        {WAVE_BARS.map(({ id, shape }) => (
          <span
            key={`self-${id}`}
            className="weq-call-wave-bar"
            style={{ ['--bar' as string]: String(callWaveBar(shape, selfLevel)) }}
          />
        ))}
        {WAVE_BARS.map(({ id, shape }, index) => (
          <span
            key={`peer-${id}`}
            className={`weq-call-wave-bar is-peer${index === 0 ? ' is-peer-start' : ''}`}
            style={{ ['--bar' as string]: String(callWaveBar(shape, peerLevel)) }}
          />
        ))}
      </div>
    </>
  );
}
