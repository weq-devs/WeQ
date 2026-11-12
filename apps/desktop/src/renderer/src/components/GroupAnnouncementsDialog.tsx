import { useContext, type ReactElement } from 'react';
import { X } from 'lucide-react';
import { GroupFeatureSurface, type GroupFeaturePresentation } from './GroupFeatureSurface';
import { GroupNoticeActions } from './qq-actions/GroupNoticeActions';
import { withQQAccountScope } from './qq-actions/shared';
import { DraftCloseContext, useDraftClose } from '../lib/draftClose';
import type { GroupBulletinWire } from '../lib/groupNotices';
export type { GroupBulletinWire, GroupBulletinImage } from '../lib/groupNotices';

interface GroupAnnouncementsProps {
  embedded?: boolean;
  anchor?: HTMLElement | null;
  presentation?: GroupFeaturePresentation;
  groupCode: string;
  groupName: string;
  currentAnnouncement?: string | null;
  bulletins?: GroupBulletinWire[];
  initialNoticeId?: string;
  onClose: () => void;
}
const ScopedGroupAnnouncements = withQQAccountScope(GroupAnnouncementsBody);
export function GroupAnnouncementsDialog(props: GroupAnnouncementsProps): ReactElement {
  return <ScopedGroupAnnouncements key={props.groupCode} {...props} />;
}
function GroupAnnouncementsBody({
  embedded,
  anchor,
  presentation,
  groupCode,
  groupName,
  currentAnnouncement,
  bulletins,
  initialNoticeId,
  onClose,
}: GroupAnnouncementsProps): ReactElement {
  const closing = useDraftClose(onClose, null);
  const parentDrafts = useContext(DraftCloseContext);
  return (
    <DraftCloseContext.Provider value={embedded && parentDrafts ? parentDrafts : closing.drafts}>
      <GroupFeatureSurface
        embedded={embedded}
        presentation={presentation}
        anchor={anchor}
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
              initialNoticeId={initialNoticeId}
              preserveDraft={presentation === 'popover'}
            />
          </div>
        </section>
      </GroupFeatureSurface>
    </DraftCloseContext.Provider>
  );
}
