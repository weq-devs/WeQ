import { EyeOff } from 'lucide-react';
import { usePrivacyStore } from '../../state/privacy';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { AppLockSection } from './AppLockSection';
import { DesktopOnly } from '../../lib/target';

export function PrivacySection() {
  const enabled = usePrivacyStore((state) => state.enabled);
  const set = usePrivacyStore((state) => state.set);
  const capturePrivacy = usePrivacyStore((state) => state.capturePrivacy);
  const setCapturePrivacy = usePrivacyStore((state) => state.setCapturePrivacy);
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
          <DesktopOnly>
            <Row
              settingId="privacy-menu-capture"
              label="在菜单中截图瞬间临时启用隐私模式"
              desc="仅影响菜单中的窗口截图，截图结束后恢复为当前隐私偏好，不改变普通导出的内容。"
              control={
                <Toggle
                  label="在菜单中截图瞬间临时启用隐私模式"
                  checked={capturePrivacy}
                  onChange={setCapturePrivacy}
                />
              }
            />
          </DesktopOnly>
        </Card>
      </div>
    </>
  );
}
