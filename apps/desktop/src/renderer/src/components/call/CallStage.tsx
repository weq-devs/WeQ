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
  /** 对端视频画布。非空即进入视频布局。 */
  peerCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** 对端视频是否已有画面（决定显示画布还是加载态）。 */
  peerVideoActive?: boolean;
  /** 本端视频画布（画中画小窗）。 */
  selfCanvasRef?: React.RefObject<HTMLCanvasElement | null>;
  /** 本端摄像头是否开着。 */
  selfVideoOn?: boolean;
  /** 对端是否在发视频（决定要不要铺满对端画面）。 */
  peerVideoOn?: boolean;
  /** 对端视频解码不可用时的提示；非空时画占位。 */
  videoError?: string | null;
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
  peerCanvasRef,
  peerVideoActive = false,
  selfCanvasRef,
  selfVideoOn = false,
  peerVideoOn = false,
  videoError = null,
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

  /**
   * 四种布局（`data-layout` 让 CSS 分流）：
   *
   *   audio       双方语音 —— 背景 / 光环 / 大头像 / 波形（原有形态）
   *   peer        只有对端开视频 —— 对端铺满，头像缩到角落
   *   self        双方都有视频 —— 对端铺满 + 本端画中画
   *   self-only   只有本端开视频 —— 本端铺满，对端头像缩到角落
   *
   * 判定看**各自独立**的两个事实：`peerVideoOn` 决定主画面是谁，`selfVideoOn`
   * 决定有没有画中画。本端开摄像头不该让主画面变成「等待对方画面」—— 那是
   * 两件不相干的事。
   *
   * 主画面用「对端在发视频」而不是「已有画面」：首帧到达前保持视频布局，
   * 否则会先闪一下语音形态再跳过去。
   */
  const layout: 'audio' | 'peer' | 'self' | 'self-only' = peerVideoOn
    ? selfVideoOn
      ? 'self'
      : 'peer'
    : selfVideoOn
      ? 'self-only'
      : 'audio';

  return (
    <div className="weq-call-stage" data-layout={layout}>
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

      {/* 对端画面。只有对端真的在发视频才挂载 —— 本端自己开摄像头不该让这里
          出现「等待对方画面」，那是两件独立的事。 */}
      {peerVideoOn && peerCanvasRef ? (
        <div className="weq-call-peer-video">
          <canvas ref={peerCanvasRef} className={peerVideoActive ? 'is-active' : ''} />
          {!peerVideoActive ? (
            <div className="weq-call-peer-video-hint">
              {videoError ? (
                <span>{videoError}</span>
              ) : (
                <>
                  <Loader2 size={18} className="weq-call-spin" />
                  <span>等待对方画面…</span>
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 呼吸光环：接通后跟随对端响度。视频布局下不画（会糊在画面上）。 */}
      {layout === 'audio' ? (
        <div className="weq-call-halo" style={{ ['--peer-level' as string]: peerLevel }} />
      ) : null}

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

      {/* 本端画面。
          - self 布局：右下角画中画
          - self-only 布局：铺满主区域（对端没开视频，只有自己）
          没有编码器时 canvas 一直是空的，CSS 的占位文字会盖住。 */}
      {selfCanvasRef && (layout === 'self' || layout === 'self-only') ? (
        <div className={`weq-call-self-video${layout === 'self-only' ? ' is-full' : ''}`}>
          <canvas ref={selfCanvasRef} />
        </div>
      ) : null}

      {/* 波形：两排细柱，左本端右对端。视频布局下收成一条窄带。 */}
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
    </div>
  );
}
