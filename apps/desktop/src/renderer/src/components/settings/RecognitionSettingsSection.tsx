import { useContext, useState } from 'react';
import type { RecognitionPriority } from '@weq/service';
import { AudioLines, Package, ScanText } from 'lucide-react';
import { Card, Row, SectionHeader } from './controls';
import { SegmentedControl } from '../SegmentedControl';
import { useTabActive } from '../RetainedTabs.shared';
import { trpc } from '../../trpc/client';
import { SettingsNavigateContext } from './controls.shared';
import { RecognitionConcurrencySetting } from './RecognitionConcurrencySetting';
import { OcrPrefilterSetting } from './OcrPrefilterSetting';

export function EnhancementPacksLink() {
  const navigate = useContext(SettingsNavigateContext);
  return (
    <button
      type="button"
      className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
      onClick={() => navigate?.('enhancement-packs')}
    >
      <Package size={14} />
      增强包
    </button>
  );
}

function RecognitionPrioritySetting({ kind }: { kind: 'ocr' | 'voice' }) {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, { enabled: active });
  const save = trpc.bootstrap.setRecognitionPriority.useMutation();
  const utils = trpc.useUtils();
  const [error, setError] = useState('');
  const label = kind === 'ocr' ? '图片文字识别优先使用' : '语音转写优先使用';
  const value =
    kind === 'ocr' ? settings.data?.ocr.priority : settings.data?.voiceTranscribe.priority;

  async function change(priority: RecognitionPriority) {
    setError('');
    try {
      await save.mutateAsync({ kind, priority });
      await utils.bootstrap.getSettings.invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <Row
        settingId={`${kind}-recognition-priority`}
        label={label}
        desc="用于聊天里手动识别和即时导出，首选失败时尝试另一种方式。"
        control={
          <SegmentedControl<RecognitionPriority>
            label={label}
            value={value ?? (kind === 'ocr' ? 'qq' : 'local')}
            disabled={!settings.data || save.isLoading}
            options={[
              { value: 'local', label: '本地模型' },
              { value: 'qq', label: 'QQ 在线' },
            ]}
            onChange={(priority) => void change(priority)}
          />
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

export function RecognitionSettingsSection() {
  return (
    <div className="weq-set weq-recognition-settings">
      <SectionHeader title="识别与转写" page="recognition" />
      <Card title="图片文字识别" icon={<ScanText size={15} strokeWidth={1.8} />}>
        <RecognitionPrioritySetting kind="ocr" />
        <RecognitionConcurrencySetting kind="ocr" />
        <OcrPrefilterSetting />
      </Card>
      <Card title="语音转写" icon={<AudioLines size={15} strokeWidth={1.8} />}>
        <RecognitionPrioritySetting kind="voice" />
        <RecognitionConcurrencySetting kind="voice" />
      </Card>
    </div>
  );
}
