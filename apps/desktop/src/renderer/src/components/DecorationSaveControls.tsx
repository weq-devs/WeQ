import { Loader2, Save } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import { useDevelopmentDressTools } from '../hooks/useDevelopmentDressTools';
import { IS_WEB } from '../lib/target.shared';
import '../styles/decoration-save.css';

export function DecorationSaveControls({
  className,
  label = '保存',
  title,
  busy,
  disabled,
  onSave,
}: {
  className: string;
  label?: string;
  title: string;
  busy: boolean;
  disabled: boolean;
  onSave: (intent?: ExportSavePolicy, browser?: boolean) => void;
}) {
  const developmentDressTools = useDevelopmentDressTools();
  if (!developmentDressTools) return null;
  return (
    <div className="weq-save-action-group">
      <button
        type="button"
        className={className}
        title={IS_WEB ? '保存到服务器' : title}
        aria-label={title}
        disabled={disabled}
        onClick={() => onSave()}
      >
        {busy ? <Loader2 size={13} className="weq-spin" /> : <Save size={13} />}
        {IS_WEB ? null : <span>{label}</span>}
      </button>
    </div>
  );
}
