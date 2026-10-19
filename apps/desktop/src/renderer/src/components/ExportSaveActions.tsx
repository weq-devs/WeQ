import { useState } from 'react';
import { ChevronDown, Clock, FolderOpen } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import { ConversationActionsMenu } from './ConversationActionsMenu';
import { IS_WEB } from '../lib/target';
import '../styles/export-save-actions.css';

export function ExportSaveActions({
  disabled = false,
  onSelect,
}: {
  disabled?: boolean;
  onSelect: (policy: ExportSavePolicy) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        className="weq-save-options"
        aria-label="本次保存选项"
        title="本次保存选项"
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        disabled={disabled}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <ChevronDown size={16} />
      </button>
      {menu && (
        <ConversationActionsMenu
          x={menu.x}
          y={menu.y}
          label="本次保存选项"
          onClose={() => setMenu(null)}
          actions={[
            {
              label: IS_WEB ? '另存到服务器…' : '另存到…',
              icon: <FolderOpen size={16} />,
              disabled,
              action: () => onSelect({ mode: 'before' }),
            },
            {
              label: '先生成，稍后保存',
              icon: <Clock size={16} />,
              disabled,
              action: () => onSelect({ mode: 'after' }),
            },
          ]}
        />
      )}
    </>
  );
}
