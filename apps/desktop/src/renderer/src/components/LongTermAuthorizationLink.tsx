import { ShieldCheck } from 'lucide-react';
import { requestOpenSettings } from '../lib/callSettingsBridge';

export function LongTermAuthorizationLink({
  beforeNavigate,
  className = 'weq-set-btn',
}: {
  beforeNavigate?: () => void;
  className?: string;
}) {
  if (!window.weq?.authorization) return null;
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        beforeNavigate?.();
        requestOpenSettings('longTermAuthorization');
      }}
    >
      <ShieldCheck size={14} />
      管理长期授权
    </button>
  );
}
