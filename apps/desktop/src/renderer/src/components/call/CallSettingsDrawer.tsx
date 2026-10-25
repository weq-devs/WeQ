/**
 * 通话窗口底部的设置抽屉（默认收起）。
 *
 * **通话相关的临时开关放这里，长期配置放设置页** —— 那个窗口只有 400px 宽，
 * 录音模式 / 电脑声音 / 保存位置三项已经放不下，而且它们是「一次性配好」的东西，
 * 每次通话都摆出来反而干扰。所以这里只留：
 *
 *   - 只读的通话信息（房间号、收发帧数）
 *   - 一个跳转入口，打开设置页的「通话与录音」面板
 *
 * 真正的录音配置在 `components/settings/CallRecordingSection.tsx`，两边读的是
 * 同一份全局设置（`AppSettings.callRecording`）。
 */

import { useState } from 'react';
import { ChevronDown, Settings2 } from 'lucide-react';
import { trpc } from '../../trpc/client';

export interface CallSettingsDrawerProps {
  roomId: string | null;
  sentFrames: number;
  receivedFrames: number;
  /** 本端摄像头是否开着。 */
  videoSending?: boolean;
  /** 对端是否在发视频。 */
  videoReceiving?: boolean;
  receivedVideoFrames?: number;
  /** 视频规格（分辨率），拿不到时传 null。 */
  videoSize?: { width: number; height: number } | null;
  /** 打开设置页的「通话与录音」。 */
  onOpenSettings: () => void;
}

export function CallSettingsDrawer({
  roomId,
  sentFrames,
  receivedFrames,
  videoSending = false,
  videoReceiving = false,
  receivedVideoFrames = 0,
  videoSize = null,
  onOpenSettings,
}: CallSettingsDrawerProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`weq-call-drawer${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="weq-call-drawer-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronDown size={14} className="weq-call-drawer-chevron" aria-hidden />
        <span>通话信息</span>
      </button>

      {open ? (
        <div className="weq-call-drawer-body">
          <section className="weq-call-drawer-group is-meta">
            <dl className="weq-call-drawer-meta">
              <div>
                <dt>房间</dt>
                <dd title={roomId ?? undefined}>{roomId ?? '—'}</dd>
              </div>
              <div>
                <dt>音频</dt>
                <dd>
                  {sentFrames} / {receivedFrames} 帧
                </dd>
              </div>
              {(videoSending || videoReceiving) && (
                <div>
                  <dt>视频</dt>
                  <dd>
                    {videoReceiving ? `${receivedVideoFrames} 帧` : '—'}
                    {videoSize ? ` · ${videoSize.width}×${videoSize.height}` : ''}
                  </dd>
                </div>
              )}
              {(videoSending || videoReceiving) && (
                <div>
                  <dt>摄像头</dt>
                  <dd>
                    {videoSending ? '本端开' : '本端关'}
                    {' · '}
                    {videoReceiving ? '对方开' : '对方关'}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <section className="weq-call-drawer-group">
            <button
              type="button"
              className="weq-call-drawer-link"
              onClick={onOpenSettings}
              title="打开设置 → 通话与录音"
            >
              <Settings2 size={14} />
              <span>录音与通话设置</span>
            </button>
            <span className="weq-call-drawer-hint">
              录音模式、电脑声音与保存位置在设置页统一管理
            </span>
          </section>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 通话窗口里需要的录音设置（只读）。
 *
 * 抽屉不再编辑它，但窗口仍要知道默认值去启动录音 —— 与设置页共用同一份配置。
 */
export function useCallRecordingSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const capabilities = trpc.call.recordingCapabilities.useQuery(undefined, {
    staleTime: 60_000,
  });
  return {
    config: settings.data?.callRecording ?? null,
    capability: capabilities.data?.systemAudio ?? null,
    /** 当前生效的录音目录（没自选时是默认那一层）。 */
    dir: capabilities.data?.dir ?? null,
  };
}
