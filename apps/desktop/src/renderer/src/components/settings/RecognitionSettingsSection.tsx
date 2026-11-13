import { useContext } from 'react';
import { AudioLines, Package, ScanText } from 'lucide-react';
import { Card, SectionHeader, SettingsNavigateContext } from './controls';
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

export function RecognitionSettingsSection() {
  return (
    <div className="weq-set weq-recognition-settings">
      <SectionHeader title="识别与转写" icon={<ScanText size={18} strokeWidth={1.8} />} />
      <Card title="图片文字识别" icon={<ScanText size={15} strokeWidth={1.8} />}>
        <RecognitionConcurrencySetting kind="ocr" />
        <OcrPrefilterSetting />
      </Card>
      <Card title="语音转写" icon={<AudioLines size={15} strokeWidth={1.8} />}>
        <RecognitionConcurrencySetting kind="voice" />
      </Card>
    </div>
  );
}
