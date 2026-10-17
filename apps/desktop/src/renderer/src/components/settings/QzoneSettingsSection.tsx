import { Globe } from 'lucide-react';
import { SectionHeader } from './controls';
import { QzonePaginationSettings } from './QzonePaginationSettings';

export function QzoneSettingsSection() {
  return (
    <div className="weq-set">
      <SectionHeader
        icon={<Globe size={16} strokeWidth={1.8} />}
        title="QQ 空间设置"
        desc="全局配置；此处与设置中的空间配置同步。"
      />
      <QzonePaginationSettings />
    </div>
  );
}
