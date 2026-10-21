import type { ReactElement } from 'react';
import { X } from 'lucide-react';
import { OverlayLayer } from './OverlayLayer';
import { GroupNoticeActions } from './qq-actions/GroupNoticeActions';
import { withQQAccountScope } from './qq-actions/shared';
import { DraftCloseContext, useDraftClose } from '../lib/draftClose';
import type { GroupBulletinWire } from '../lib/groupNotices';
export type { GroupBulletinWire, GroupBulletinImage } from '../lib/groupNotices';

interface GroupAnnouncementsProps {
  groupCode: string;
  groupName: string;
  currentAnnouncement?: string | null;
  bulletins?: GroupBulletinWire[];
  onClose: () => void;
}
const ScopedGroupAnnouncements = withQQAccountScope(GroupAnnouncementsBody);
export function GroupAnnouncementsDialog(props: GroupAnnouncementsProps): ReactElement {
  return <ScopedGroupAnnouncements key={props.groupCode} {...props} />;
}
function GroupAnnouncementsBody({
  groupCode,
  groupName,
  currentAnnouncement,
  bulletins,
  onClose,
}: GroupAnnouncementsProps): ReactElement {
  const closing = useDraftClose(onClose, null);
  return (
    <DraftCloseContext.Provider value={closing.drafts}>
      <OverlayLayer
        presentation="sidecar"
        title="群公告"
        className="modal-scrim group-announcements-scrim"
        onClose={closing.requestClose}
      >
        <section
          className="group-announcements-dialog"
          role="region"
          aria-label={`${groupName}的群公告`}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header>
            <div>
              <strong>群公告</strong>
              <span>{groupName}</span>
            </div>
            <button
              className="icon-button"
              type="button"
              title="关闭"
              aria-label="关闭群公告"
              onClick={closing.requestClose}
            >
              <X size={18} />
            </button>
          </header>
          <div className="group-announcements-body">
            <GroupNoticeActions
              groupId={Number(groupCode)}
              groupName={groupName}
              currentAnnouncement={currentAnnouncement}
              bulletins={bulletins}
            />
          </div>
        </section>
      </OverlayLayer>
    </DraftCloseContext.Provider>
  );
}
