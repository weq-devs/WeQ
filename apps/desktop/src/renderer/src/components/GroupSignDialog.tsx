import { X } from 'lucide-react';
import { GroupFeatureSurface, type GroupFeaturePresentation } from './GroupFeatureSurface';
import { GroupReadTools } from './qq-actions/GroupReadTools';
import { withQQAccountScope } from './qq-actions/shared';
import '../styles/group-sign.css';

function GroupSignDialogBody({
  embedded,
  anchor,
  presentation,
  groupCode,
  groupName,
  onClose,
}: {
  embedded?: boolean;
  anchor?: HTMLElement | null;
  presentation?: GroupFeaturePresentation;
  groupCode: string;
  groupName: string;
  onClose: () => void;
}) {
  return (
    <GroupFeatureSurface
      embedded={embedded}
      presentation={presentation}
      anchor={anchor}
      title="群打卡"
      className={presentation === 'popover' ? 'weq-group-sign-layer' : undefined}
      onClose={onClose}
    >
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
    </GroupFeatureSurface>
  );
}

export const GroupSignDialog = withQQAccountScope(GroupSignDialogBody);
