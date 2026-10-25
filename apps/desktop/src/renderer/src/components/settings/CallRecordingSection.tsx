/**
 * 设置 → 通话与录音。
 *
 * 与通话窗口里的「通话与录音设置」抽屉读的是**同一份**全局配置
 * （`AppSettings.callRecording`），改哪边都一样。
 *
 * 录音默认**不自动开** —— 要在通话窗口里手动点录音键。这里配的是「怎么录」：
 * 录谁、要不要带上电脑声音、文件放哪。
 */

import type { ReactElement } from 'react';
import { FolderOpen, Info, PhoneCall, RotateCcw } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';
import type { CallRecordingMode } from '@weq/service';

const MODE_OPTIONS: ReadonlyArray<{ value: CallRecordingMode; label: string; hint: string }> = [
  { value: 'self', label: '仅本端', hint: '只录自己说话' },
  { value: 'peer', label: '仅对方', hint: '只录对方说话' },
  { value: 'mixed', label: '双方混合', hint: '双方叠在一起，最接近现场听感' },
];

export function CallRecordingSection(): ReactElement {
  const pushToast = useToast((state) => state.push);
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const capabilities = trpc.call.recordingCapabilities.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const setSettings = trpc.bootstrap.setCallRecording.useMutation({
    onSuccess: () => void settings.refetch(),
    onError: (error) =>
      pushToast({
        tone: 'error',
        message: '保存通话录音设置失败',
        detail: error instanceof Error ? error.message : String(error),
      }),
  });
  const pickDir = trpc.bootstrap.pickCallRecordingDir.useMutation({
    onSuccess: (dir) => {
      if (dir) void settings.refetch();
    },
  });

  const config = settings.data?.callRecording;
  const capability = capabilities.data?.systemAudio ?? null;
  const systemUnsupported = capability === 'unsupported';
  const mode = config?.mode ?? 'mixed';

  return (
    <div className="weq-set">
      <SectionHeader
        title="通话与录音"
        desc="通话接通后，在通话窗口里手动开始录音。这里配置录制内容和文件位置。"
        icon={<PhoneCall size={16} strokeWidth={1.8} />}
      />

      <Card title="录制内容" icon={<PhoneCall size={15} strokeWidth={1.8} />}>
        <Row
          label="录音来源"
          desc={MODE_OPTIONS.find((option) => option.value === mode)?.hint}
          control={
            <div className="weq-set-seg" role="radiogroup" aria-label="录音来源">
              {MODE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={mode === option.value}
                  className={`weq-set-seg-item${mode === option.value ? ' is-on' : ''}`}
                  disabled={setSettings.isLoading || !config}
                  onClick={() => setSettings.mutate({ mode: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
        />
        <Row
          label="同时录电脑声音"
          desc={
            systemUnsupported
              ? '当前平台不支持。macOS 需要先装 BlackHole 之类的虚拟声卡，再把系统输出指过去。'
              : '把电脑正在播放的声音一并录进文件。它只会进录音，不会发给对方。'
          }
          control={
            <Toggle
              checked={Boolean(config?.systemAudio) && !systemUnsupported}
              disabled={systemUnsupported || setSettings.isLoading || !config}
              onChange={(next) => setSettings.mutate({ systemAudio: next })}
              label="同时录电脑声音"
            />
          }
        />
      </Card>

      <Card title="保存位置" icon={<FolderOpen size={15} strokeWidth={1.8} />}>
        <Row
          label={config?.dir ?? '默认目录'}
          desc={
            config?.dir
              ? '自定义目录。录音与索引文件都放在这里。'
              : '按账号分开存放在应用数据目录下的 recordings 里。'
          }
          control={
            <div className="weq-set-btn-group">
              <button
                type="button"
                className="weq-set-btn"
                disabled={pickDir.isLoading}
                onClick={() => pickDir.mutate()}
              >
                <FolderOpen size={14} strokeWidth={1.8} aria-hidden />
                选择目录
              </button>
              <button
                type="button"
                className="weq-set-btn weq-set-btn-soft"
                disabled={setSettings.isLoading || !config?.dir}
                onClick={() => setSettings.mutate({ dir: null })}
              >
                <RotateCcw size={14} strokeWidth={1.8} aria-hidden />
                恢复默认
              </button>
            </div>
          }
        />
      </Card>

      <div className="weq-set-note">
        <Info size={14} aria-hidden />
        <span>
          录音不会自动开始。通话结束后，窗口里可以直接播放；如果这通电话在聊天里留下了通话记录，那条消息旁边也会出现播放按钮。
        </span>
      </div>
    </div>
  );
}
