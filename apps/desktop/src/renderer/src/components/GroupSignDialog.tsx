import { X } from 'lucide-react';
import { OverlayLayer } from './OverlayLayer';
import { GroupReadTools } from './qq-actions/GroupReadTools';
import { withQQAccountScope } from './qq-actions/shared';
import '../styles/group-sign.css';

function GroupSignDialogBody({
  groupCode,
  groupName,
  onClose,
}: {
  groupCode: string;
  groupName: string;
  onClose: () => void;
}) {
  return (
    <OverlayLayer presentation="sidecar" title="群打卡" onClose={onClose}>
      <section className="weq-group-sign-page" aria-label="群打卡">
        <header>
          <div>
            <strong>群打卡</strong>
            <span>{groupName}</span>
          </div>
          <button
            type="button"
            className="icon-button"
            title="关闭群打卡"
            aria-label="关闭群打卡"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="weq-group-sign-body">
          <GroupReadTools key={groupCode} groupId={Number(groupCode)} signing />
        </div>
      </section>
    </OverlayLayer>
  );
}

export const GroupSignDialog = withQQAccountScope(GroupSignDialogBody);
