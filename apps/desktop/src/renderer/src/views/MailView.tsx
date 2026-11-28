import { memo, useMemo, useState } from 'react';
import { MailPage } from './mail/MailPage';
import { createMailApi } from './mail/api';
import { X } from 'lucide-react';
import { Modal } from '../components/Dialog';
import { MailSettingsSection } from '../components/settings/MailSettingsSection';
import { useTabActive } from '../components/RetainedTabs.shared';
import { PageSnapshotScope } from '../components/PageSnapshots';
import type { MailOpenTarget } from '../lib/mailNavigation';

export const MailWorkspace = memo(function MailWorkspace({
  active,
  selfUin,
  searchTarget,
}: {
  active: boolean;
  selfUin: string;
  searchTarget?: MailOpenTarget | null;
}) {
  const parentActive = useTabActive();
  const foreground = active && parentActive;
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLButtonElement | null>(null);
  const closeSettings = () => setSettingsAnchor(null);
  const api = useMemo(() => createMailApi(selfUin), [selfUin]);
  return (
    <PageSnapshotScope name="mail">
      <div hidden={!foreground} className="weq-mail-retained">
        <MailPage
          key={selfUin}
          api={api}
          selfEmail={`${selfUin}@qq.com`}
          active={foreground}
          searchTarget={searchTarget}
          settingsOpen={Boolean(settingsAnchor)}
          onToggleSettings={(trigger) => setSettingsAnchor((current) => (current ? null : trigger))}
        />
        {settingsAnchor && foreground ? (
          <Modal
            presentation="popover"
            anchor={settingsAnchor}
            fitAnchorHeight
            width={480}
            labelledBy="weq-mail-settings-title"
            onClose={closeSettings}
          >
            <header className="weq-tools-header">
              <h2 id="weq-mail-settings-title">邮箱设置</h2>
              <button
                type="button"
                title="关闭邮箱设置"
                aria-label="关闭邮箱设置"
                onClick={closeSettings}
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
    </PageSnapshotScope>
  );
});
