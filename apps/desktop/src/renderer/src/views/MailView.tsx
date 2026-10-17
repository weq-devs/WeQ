import { memo, useEffect, useMemo, useState } from 'react';
import { MailPage } from './mail/MailPage';
import { createMailApi } from './mail/api';

export const MailWorkspace = memo(function MailWorkspace({
  active,
  selfUin,
  onUnreadChange,
  enabled = false,
  onOpenRequested,
}: {
  active: boolean;
  selfUin: string;
  onUnreadChange: (count: number) => void;
  enabled?: boolean;
  onOpenRequested?: () => void;
}) {
  const [visited, setVisited] = useState(active);
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
      />
    </div>
  ) : null;
});
