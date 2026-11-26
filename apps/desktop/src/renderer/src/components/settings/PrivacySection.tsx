import { useContext } from 'react';
import { EyeOff } from 'lucide-react';
import { usePrivacyStore } from '../../state/privacy';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { AppLockSection } from './AppLockSection';
import { IS_WEB } from '../../lib/target.shared';
import { NotificationSettingsLink } from './NotificationSettingsLink';
import { BeforeLoginSettingsContext, OPEN_ACCOUNT_SETTINGS_HINT } from './controls.shared';

export function PrivacySection() {
  const beforeLogin = useContext(BeforeLoginSettingsContext);
  const enabled = usePrivacyStore((state) => state.enabled);
  const set = usePrivacyStore((state) => state.set);
  const capturePrivacy = usePrivacyStore((state) => state.capturePrivacy);
  const setCapturePrivacy = usePrivacyStore((state) => state.setCapturePrivacy);
  return (
    <>
      <div className="weq-set">
        <SectionHeader title="隐私" page="privacy" pageReset={!beforeLogin} />
      </div>
      <div className="weq-set">
        <Card
          title="隐私模式"
          icon={<EyeOff size={15} strokeWidth={1.8} />}
          settingId="privacy-mode"
        >
          <Row
            label="启用隐私模式"
            desc="仅遮盖界面中的个人信息，不加密或修改原始数据，也不改变普通导出的内容。"
            control={<Toggle label="隐私模式" checked={enabled} onChange={set} />}
          />
          <Row
            settingId="privacy-menu-capture"
            desc="仅影响菜单中的窗口截图，截图结束后恢复为当前隐私偏好，不改变普通导出的内容。"
            control={
              <Toggle
                label="在菜单中截图瞬间临时启用隐私模式"
                checked={capturePrivacy}
                onChange={setCapturePrivacy}
              />
            }
          />
        </Card>
      </div>
      {beforeLogin ? (
        <div className="weq-set">
          <Card title="应用锁" desc={OPEN_ACCOUNT_SETTINGS_HINT} />
        </div>
      ) : (
        <AppLockSection heading={false} />
      )}
      {IS_WEB && (
        <div className="weq-set">
          <NotificationSettingsLink settingId="web-notifications">
            网页通知设置
          </NotificationSettingsLink>
        </div>
      )}
    </>
  );
}
