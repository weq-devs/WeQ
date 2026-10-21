import { memo, useEffect, useMemo, useState } from 'react';
import { MailPage } from './mail/MailPage';
import { createMailApi } from './mail/api';
import { X } from 'lucide-react';
import { Modal } from '../components/Dialog';
import { MailSettingsSection } from '../components/settings/MailSettingsSection';

export const MailWorkspace = memo(function MailWorkspace({
  active,
  selfUin,
  onUnreadChange,
  enabled = false,
  onOpenRequested,
  searchTarget,
}: {
  active: boolean;
  selfUin: string;
  onUnreadChange: (count: number) => void;
  enabled?: boolean;
  onOpenRequested?: () => void;
  searchTarget?: { id: string; folderId: number; revision: string } | null;
}) {
  const [visited, setVisited] = useState(active);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const api = useMemo(() => createMailApi(selfUin), [selfUin]);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);
  return active || visited || enabled ? (
    <div hidden={!active} className="weq-mail-retained">
      <MailPage
        key={selfUin}
        api={api}
        selfEmail={`${selfUin}@qq.com`}
        active={active}
        onUnreadChange={onUnreadChange}
        onOpenRequested={onOpenRequested}
        searchTarget={searchTarget}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {settingsOpen && active ? (
        <Modal
          presentation="panel"
          width={760}
          labelledBy="weq-mail-settings-title"
          onClose={() => setSettingsOpen(false)}
        >
          <header className="weq-tools-header">
            <h2 id="weq-mail-settings-title">邮箱设置</h2>
            <button
              type="button"
              title="关闭邮箱设置"
              aria-label="关闭邮箱设置"
              onClick={() => setSettingsOpen(false)}
            >
              <X size={18} />
            </button>
          </header>
          <div className="weq-local-settings-body">
            <MailSettingsSection />
          </div>
        </Modal>
      ) : null}
    </div>
  ) : null;
});
