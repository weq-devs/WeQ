import { useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import type { User } from '../im-template/template/types';
import { ContactWorkspaceNavigationContext } from '../lib/profileNavigation';
import type { AnalysisTarget } from '../views/analysis/model';
import {
  useContactCardSettings,
  useContactProfile,
  type ProfilePerson,
} from '../hooks/useContactCard';
import { OverlayLayer } from './OverlayLayer';
import {
  ContactContent,
  ContactGroupContent,
  ContactIdentity,
} from './contactProfile/ContactContent';
import { ContactActions } from './contactProfile/ContactActions';

/** 群成员、私聊头像和联系人浮层共用内容，只保留贴屏定位这一层差异。 */
export function MemberProfileCard({
  member,
  anchor,
  onClose,
  groupCode,
  groupName,
  onOpenChat,
  onPreviewChat,
  previewContent,
  onAnalyze,
  localClone = Boolean(member.clone),
}: {
  member: User;
  anchor: { x: number; y: number };
  onClose: () => void;
  groupCode?: string;
  groupName?: string;
  onOpenChat?: () => void;
  onPreviewChat?: () => void;
  previewContent?: ReactNode;
  onAnalyze?: (target: AnalysisTarget) => void;
  localClone?: boolean;
}) {
  const settings = useContactCardSettings();
  const { profile, scope } = useContactProfile({ ...member, clone: localClone });
  const identityKey = JSON.stringify([
    ...scope,
    member.uid || member.id || member.identityValue,
    groupCode || profile.profileContext?.groupCode,
    localClone,
  ]);
  const person: ProfilePerson =
    groupCode && !localClone
      ? {
          ...profile,
          profileContext: {
            groupCode,
            groupName: groupName || '',
            member: profile.profileContext?.member ?? member,
          },
        }
      : profile;
  const open = useContext(ContactWorkspaceNavigationContext);
  const card = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({ left: 10, top: 10 });
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const place = () => {
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = Math.max(
        10,
        Math.min(
          anchor.x + 14 + width > innerWidth - 10 ? anchor.x - width - 14 : anchor.x + 14,
          innerWidth - width - 10,
        ),
      );
      const top = Math.max(10, Math.min(anchor.y + 8, innerHeight - height - 10));
      setPosition((previous) =>
        previous.left === left && previous.top === top ? previous : { left, top },
      );
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(element);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor.x, anchor.y]);
  return (
    <OverlayLayer presentation="popover" className="weq-member-pop-scrim" onClose={onClose}>
      <section
        ref={card}
        className={`weq-member-pop weq-contact-card${previewContent ? ' is-previewing-chat' : ''}`}
        role="dialog"
        aria-label="用户资料"
        style={{ position: 'fixed', ...position }}
      >
        <button
          type="button"
          className="weq-profile-close"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={16} />
        </button>
        {previewContent || (
          <>
            <ContactIdentity
              key={`identity:${identityKey}`}
              person={person}
              pendant={settings.ready && settings.visible.pendant}
              onOpen={
                !localClone && open
                  ? () => {
                      onClose();
                      open({ kind: 'person', contact: { createdAt: '', ...person } });
                    }
                  : undefined
              }
            />
            {!localClone ? (
              <>
                <ContactContent
                  key={`content:${identityKey}`}
                  person={person}
                  settings={settings}
                  onNavigate={onClose}
                  localOnly={!settings.ready}
                />
                <ContactGroupContent person={person} settings={settings} />
              </>
            ) : null}
            <ContactActions
              key={`actions:${identityKey}`}
              person={person}
              onClose={onClose}
              onOpenChat={onOpenChat}
              onPreviewChat={onPreviewChat}
              onAnalyze={onAnalyze}
            />
          </>
        )}
      </section>
    </OverlayLayer>
  );
}
