import { useState, type ReactElement } from 'react';
import { HardDrive } from 'lucide-react';
import { Row, SectionHeader } from './controls';
import { VoiceTranscribeSection } from './VoiceTranscribeSection';
import { OcrModelsSection } from './OcrModelsSection';

export type LocalModelKind = 'voice' | 'ocr';

export function LocalModelsSection({
  initialKind = 'voice',
}: {
  initialKind?: LocalModelKind;
}): ReactElement {
  const [kind, setKind] = useState<LocalModelKind>(initialKind);
  return (
    <>
      <div className="weq-set">
        <SectionHeader title="语音与图片识别" icon={<HardDrive size={18} />} />
        <Row
          label="用途"
          control={
            <select
              className="weq-set-input"
              aria-label="本地模型用途"
              value={kind}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'voice' || value === 'ocr') setKind(value);
              }}
            >
              <option value="voice">语音识别</option>
              <option value="ocr">图片识别与筛图</option>
            </select>
          }
        />
      </div>
      {kind === 'voice' ? <VoiceTranscribeSection /> : <OcrModelsSection />}
    </>
  );
}
