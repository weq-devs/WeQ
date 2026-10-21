import { Globe } from 'lucide-react';
import { SectionHeader } from './controls';
import { QzonePaginationSettings } from './QzonePaginationSettings';

export function QzoneSettingsSection() {
  return (
    <div className="weq-set">
      <SectionHeader icon={<Globe size={16} strokeWidth={1.8} />} title="QQ 空间" />
      <QzonePaginationSettings />
    </div>
  );
}
