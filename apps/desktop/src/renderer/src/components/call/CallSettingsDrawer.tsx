/**
 * 通话窗口底部的设置抽屉（默认收起）。
 *
 * **以后通话相关的新设置都往这里加**，不要往舞台或操作栏里堆 —— 那个窗口只有
 * 400px 宽，主舞台该留给头像和波形。抽屉里的改动即时生效（直接写全局设置），
 * 也影响下一次通话，和设置页里那一份是同一份数据。
 *
 * 现在只有三组：
 *   - 录音模式（仅本端 / 仅对方 / 双方）
 *   - 电脑声音（平台不支持时置灰并说明）
 *   - 保存位置（默认目录 / 自选）
 * 外加一个只读的「通话信息」。
 */

import { useState } from 'react';
import { ChevronDown, FolderOpen } from 'lucide-react';
import { trpc } from '../../trpc/client';
import type { CallRecordingMode } from '../../hooks/useCallRecorder';

const MODES: ReadonlyArray<{ value: CallRecordingMode; label: string; hint: string }> = [
  { value: 'self', label: '仅本端', hint: '只录自己说话' },
  { value: 'peer', label: '仅对方', hint: '只录对方说话' },
  { value: 'mixed', label: '双方', hint: '双方混音' },
];

export interface CallSettingsDrawerProps {
  mode: CallRecordingMode;
  systemAudio: boolean;
  capability: 'native' | 'renderer' | 'unsupported' | null;
  recordingDir: string | null;
  /** 录音进行中：模式与电脑声音锁定（改不了已开的那份）。 */
  locked: boolean;
  roomId: string | null;
  sentFrames: number;
  receivedFrames: number;
  onModeChange: (mode: CallRecordingMode) => void;
  onSystemAudioChange: (enabled: boolean) => void;
  onPickDir: () => void;
}

export function CallSettingsDrawer({
  mode,
  systemAudio,
  capability,
  recordingDir,
  locked,
  roomId,
  sentFrames,
  receivedFrames,
  onModeChange,
  onSystemAudioChange,
  onPickDir,
}: CallSettingsDrawerProps) {
  const [open, setOpen] = useState(false);
  const unsupported = capability === 'unsupported';

  return (
    <div className={`weq-call-drawer${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="weq-call-drawer-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ChevronDown size={14} className="weq-call-drawer-chevron" aria-hidden />
        <span>通话与录音设置</span>
      </button>

      {open ? (
        <div className="weq-call-drawer-body">
          <section className="weq-call-drawer-group">
            <span className="weq-call-drawer-label">录音内容</span>
            <div className="weq-call-seg" role="radiogroup" aria-label="录音内容">
              {MODES.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === option.value}
                  className={`weq-call-seg-item${mode === option.value ? ' is-on' : ''}`}
                  disabled={locked}
                  title={option.hint}
                  onClick={() => onModeChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <span className="weq-call-drawer-hint">
              {locked ? '录音进行中，停止后可修改' : '对下一次开始的录音生效'}
            </span>
          </section>

          <section className="weq-call-drawer-group">
            <label className="weq-call-drawer-switch">
              <span>
                <span className="weq-call-drawer-label">同时录电脑声音</span>
                <span className="weq-call-drawer-hint">
                  {unsupported ? '当前平台不支持；macOS 需要虚拟声卡' : '只进录音，不会发给对方'}
                </span>
              </span>
              <input
                type="checkbox"
                className="weq-call-switch"
                checked={systemAudio && !unsupported}
                disabled={unsupported || locked}
                onChange={(event) => onSystemAudioChange(event.target.checked)}
              />
            </label>
          </section>

          <section className="weq-call-drawer-group">
            <span className="weq-call-drawer-label">保存位置</span>
            <div className="weq-call-drawer-path">
              <span title={recordingDir ?? '默认目录'}>{recordingDir ?? '默认目录'}</span>
              <button
                type="button"
                className="weq-call-drawer-pick"
                onClick={onPickDir}
                disabled={locked}
                title="选择保存文件夹"
              >
                <FolderOpen size={14} />
              </button>
            </div>
          </section>

          <section className="weq-call-drawer-group is-meta">
            <dl className="weq-call-drawer-meta">
              <div>
                <dt>房间</dt>
                <dd title={roomId ?? undefined}>{roomId ?? '—'}</dd>
              </div>
              <div>
                <dt>已发送</dt>
                <dd>{sentFrames} 帧</dd>
              </div>
              <div>
                <dt>已接收</dt>
                <dd>{receivedFrames} 帧</dd>
              </div>
            </dl>
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** 抽屉里那三组设置的数据源（读 + 写），与设置页共用同一份配置。 */
export function useCallRecordingSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const setSettings = trpc.bootstrap.setCallRecording.useMutation({
    onSuccess: () => void settings.refetch(),
  });
  const pickDir = trpc.bootstrap.pickCallRecordingDir.useMutation({
    onSuccess: () => {
      void settings.refetch();
      void capabilities.refetch();
    },
  });
  const capabilities = trpc.call.recordingCapabilities.useQuery(undefined, {
    staleTime: 60_000,
  });
  return {
    config: settings.data?.callRecording ?? null,
    capability: capabilities.data?.systemAudio ?? null,
    /** 当前生效的录音目录（没自选时是默认那一层）。 */
    dir: capabilities.data?.dir ?? null,
    update: setSettings.mutate,
    pickDir: pickDir.mutate,
  };
}
