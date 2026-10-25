import { EyeOff } from 'lucide-react';
import { usePrivacyStore } from '../../state/privacy';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { AppLockSection } from './AppLockSection';

export function PrivacySection() {
  const enabled = usePrivacyStore((state) => state.enabled);
  const set = usePrivacyStore((state) => state.set);
  return (
    <>
      <div className="weq-set">
        <SectionHeader title="隐私" icon={<EyeOff size={16} />} />
      </div>
      <AppLockSection heading={false} />
      <div className="weq-set">
        <Card title="隐私模式" settingId="privacy-mode">
          <Row
            label="隐私模式"
            desc="仅遮盖界面中的个人信息，不加密或修改原始数据，也不改变普通导出的内容。"
            control={<Toggle label="隐私模式" checked={enabled} onChange={set} />}
          />
        </Card>
      </div>
    </>
  );
}
