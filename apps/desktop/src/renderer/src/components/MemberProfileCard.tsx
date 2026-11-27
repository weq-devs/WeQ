import type { ProfilePoint } from '../lib/profileCardMotion';
import { useContext, useEffect, type ReactNode } from 'react';
import type { User } from '../im-template/template/types';
import { ContactWorkspaceNavigationContext } from '../lib/profileNavigation';
import type { AnalysisTarget } from '../views/analysis/model';
import {
  useContactCardSettings,
  useContactProfile,
  type ProfilePerson,
} from '../hooks/useContactCard';
import { MemberProfileCardFrame } from './MemberProfileCardFrame';
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
  anchor: ProfilePoint;
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
  // 关闭后把焦点还给打开名片的那个元素，键盘用户不会「丢了位置」。
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <SelfProfileFieldsContext.Provider value={null}>
      <ReadonlyProfileDisplay>
        <MemberProfileCardFrame
          anchor={anchor}
          onClose={onClose}
          previewing={Boolean(previewContent)}
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
        </MemberProfileCardFrame>
      </ReadonlyProfileDisplay>
    </SelfProfileFieldsContext.Provider>
  );
}
