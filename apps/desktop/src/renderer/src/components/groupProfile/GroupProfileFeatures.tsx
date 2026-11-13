import { useContext, useEffect, useRef, useState } from 'react';
import { Bell, CalendarCheck, CheckSquare, Files, Images, Star } from 'lucide-react';
import type { GroupConversation } from '../../im-template/template/types';
import type { GroupWorkspaceTab } from '../../lib/profileNavigation';
import {
  ConversationSettingsNavigationContext,
  GroupResourceNavigationContext,
} from '../../lib/conversationSettingsNavigation';
import { useGroupResourceWindows } from '../../hooks/useGroupResourceWindows';
import { useTabActive } from '../RetainedTabs';
import { GroupAnnouncementsDialog } from '../GroupAnnouncementsDialog';
import { GroupSignDialog } from '../GroupSignDialog';
import { GroupTodos } from '../qq-actions/GroupActions';
import { ConversationSettingsDialog } from '../ConversationSettingsDialog';
import { GroupProfileEssence } from './GroupWorkspace';

const features = [
  ['announcements', '公告', Bell],
  ['todos', '待办', CheckSquare],
  ['albums', '相册', Images],
  ['files', '文件', Files],
  ['essence', '精华', Star],
  ['sign', '打卡', CalendarCheck],
] as const;
type Feature = (typeof features)[number][0];

export function GroupProfileFeatures({
  conversation,
  scope,
  section,
  albumId,
  folderId,
  fileId,
}: {
  conversation: GroupConversation;
  scope: string;
  section?: GroupWorkspaceTab;
  albumId?: string;
  folderId?: string;
  fileId?: string;
}) {
  const resources = useContext(GroupResourceNavigationContext);
  const settings = useContext(ConversationSettingsNavigationContext);
  const fallback = useGroupResourceWindows({ ownerKey: scope });
  const active = useTabActive();
  const root = useRef<HTMLDivElement>(null);
  const handled = useRef('');
  const [feature, setFeature] = useState<{
    kind: Feature | 'management';
    anchor: HTMLElement | null;
  } | null>(null);
  const current = useRef({ conversation, resources, settings, fallback });
  current.current = { conversation, resources, settings, fallback };
  function open(kind: Feature | 'management', anchor: HTMLElement | null) {
    const { conversation: target, resources, settings, fallback } = current.current;
    if (kind === 'albums' || kind === 'files') {
      setFeature(null);
      (resources ?? fallback.open)({
        kind,
        groupCode: target.id,
        groupName: target.group.name,
        initialAlbumId: albumId,
        initialFolderId: folderId,
        initialFileId: fileId,
      });
    } else if (kind === 'management' && settings) {
      settings({
        kind: 'group',
        conv: target.id,
        title: target.group.name,
        groupConversation: target,
        anchor: anchor ?? undefined,
        initialSection: 'group-management',
        onOpenProfile: () => {},
      });
    } else
      setFeature((previous) =>
        previous?.kind === kind && previous.anchor === anchor ? null : { kind, anchor },
      );
  }
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!active) {
      setFeature(null);
      return;
    }
    const key = JSON.stringify([scope, conversation.id, section, albumId, folderId, fileId]);
    if (handled.current === key) return;
    handled.current = key;
    const kind = section === 'content' ? 'announcements' : section;
    if (kind === 'management' || features.some(([id]) => id === kind)) {
      const anchor =
        kind === 'management'
          ? root.current
              ?.closest('.weq-group-page')
              ?.querySelector<HTMLElement>('[aria-label="会话设置"]')
          : root.current?.querySelector<HTMLElement>(`[data-feature="${kind}"]`);
      openRef.current(kind as Feature | 'management', anchor ?? null);
    }
  }, [active, scope, conversation.id, section, albumId, folderId, fileId]);
  const close = () => setFeature(null);
  const props = {
    groupCode: conversation.id,
    groupName: conversation.group.name,
    presentation: 'popover' as const,
    anchor: feature?.anchor,
    onClose: close,
  };
  return (
    <div ref={root} className="weq-group-profile-features" aria-label="群功能">
      {features.map(([kind, label, Icon]) => (
        <button
          key={kind}
          type="button"
          className="weq-contact-secondary"
          data-feature={kind}
          title={`查看群${label}`}
          aria-label={`查看群${label}`}
          onClick={(event) => open(kind, event.currentTarget)}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}
      {feature?.kind === 'announcements' ? (
        <GroupAnnouncementsDialog
          {...props}
          currentAnnouncement={conversation.group.announcement}
        />
      ) : null}
      {feature?.kind === 'sign' ? <GroupSignDialog {...props} /> : null}
      {feature?.kind === 'essence' ? (
        <GroupProfileEssence conversation={conversation} anchor={feature.anchor} onClose={close} />
      ) : null}
      {feature?.kind === 'todos' ? (
        <GroupTodos
          groupId={Number(conversation.id)}
          groupName={conversation.group.name}
          embedded
          showSummary={false}
          popoverOpen
          popoverAnchor={feature.anchor}
          onPopoverOpenChange={(open) => {
            if (!open) close();
          }}
        />
      ) : null}
      {feature?.kind === 'management' ? (
        <ConversationSettingsDialog
          kind="group"
          conv={conversation.id}
          title={conversation.group.name}
          groupConversation={conversation}
          initialSection="group-management"
          anchor={feature.anchor ?? undefined}
          onOpenProfile={close}
          onClose={close}
        />
      ) : null}
      {resources ? null : fallback.windows}
    </div>
  );
}
