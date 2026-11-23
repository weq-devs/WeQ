import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { User } from '../im-template/template/types';
import { ContactWorkspaceNavigationContext } from '../lib/profileNavigation';
import type { AnalysisTarget } from '../views/analysis/model';
import {
  useContactCardSettings,
  useContactProfile,
  type ProfilePerson,
} from '../hooks/useContactCard';
import { OverlayLayer } from './OverlayLayer';
import { ProfileCardBody } from './ProfileCardBody';
import { ProfileCardControls } from './ProfileCardControls';
import {
  ContactContent,
  ContactGroupContent,
  ContactIdentity,
} from './contactProfile/ContactContent';
import { ContactActions } from './contactProfile/ContactActions';
import '../styles/profile-workspace.css';
import { SelfProfileFieldsContext } from './SelfProfileFields.shared';
import { ReadonlyProfileDisplay } from './ProfileDisplaySettings';
import { visibleViewport } from '../lib/visibleViewport';

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
  const { profile, scope, session } = useContactProfile({ ...member, clone: localClone });
  const settings = useContactCardSettings(session.binding);
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
  const openProfile =
    !localClone && open
      ? () => {
          onClose();
          open({ kind: 'person', contact: { createdAt: '', ...person } });
        }
      : undefined;
  const card = useRef<HTMLElement>(null);
  const [position, setPosition] = useState({
    left: 10,
    top: 10,
    maxWidth: 'calc(100vw - 24px)',
    maxHeight: 'min(calc(100dvh - 24px), 720px)',
  });
  // 关闭后把焦点还给打开名片的那个元素，键盘用户不会「丢了位置」。
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element) return;
    const view = element.ownerDocument.defaultView;
    const place = () => {
      const viewport = visibleViewport(view);
      const maxWidth = Math.max(1, viewport.width - 24);
      const maxHeight = Math.max(1, Math.min(720, viewport.height - 24));
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const left = Math.max(
        viewport.left + 10,
        Math.min(
          anchor.x + 14 + width > viewport.left + viewport.width - 10
            ? anchor.x - width - 14
            : anchor.x + 14,
          viewport.left + viewport.width - width - 10,
        ),
      );
      const top = Math.max(
        viewport.top + 10,
        Math.min(anchor.y + 8, viewport.top + viewport.height - height - 10),
      );
      const next = { left, top, maxWidth: `${maxWidth}px`, maxHeight: `${maxHeight}px` };
      setPosition((previous) =>
        previous.left === left &&
        previous.top === top &&
        previous.maxWidth === next.maxWidth &&
        previous.maxHeight === next.maxHeight
          ? previous
          : next,
      );
    };
    place();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    observer?.observe(element);
    view?.addEventListener('resize', place);
    view?.visualViewport?.addEventListener('resize', place);
    view?.visualViewport?.addEventListener('scroll', place);
    return () => {
      observer?.disconnect();
      view?.removeEventListener('resize', place);
      view?.visualViewport?.removeEventListener('resize', place);
      view?.visualViewport?.removeEventListener('scroll', place);
    };
  }, [anchor.x, anchor.y]);
  return (
    <SelfProfileFieldsContext.Provider value={null}>
      <ReadonlyProfileDisplay>
        <OverlayLayer presentation="popover" className="weq-member-pop-scrim" onClose={onClose}>
          <section
            ref={card}
            className={`weq-member-pop weq-contact-card${previewContent ? ' is-previewing-chat' : ''}`}
            role="dialog"
            aria-label="用户资料"
            style={{ position: 'fixed', ...position }}
          >
            <ProfileCardControls onExpand={openProfile} onClose={onClose} />
            {previewContent || (
              <>
                {/* 只有正文滚动，底部操作条是卡片 footer：正文在操作条上方干净裁切，
                    任何滚动位置都不会出现「半截字段行压在按钮上」的观感。 */}
                <ProfileCardBody key={identityKey}>
                  <ContactIdentity
                    key={`identity:${identityKey}`}
                    person={person}
                    settings={settings}
                    cardBody
                    pendant={settings.ready && settings.visible.pendant}
                  />
                  {!localClone ? (
                    <ContactContent
                      key={`content:${identityKey}`}
                      person={person}
                      settings={settings}
                      onNavigate={onClose}
                      localOnly={!settings.ready}
                      leading={
                        <ContactGroupContent
                          person={person}
                          settings={settings}
                          onNavigate={onClose}
                        />
                      }
                    />
                  ) : null}
                </ProfileCardBody>
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
      </ReadonlyProfileDisplay>
    </SelfProfileFieldsContext.Provider>
  );
}
