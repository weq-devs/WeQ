import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Award, BrainCircuit, UserRound, Wand2 } from 'lucide-react';
import type { Contact } from '../im-template/template/types';
import type { ContactWorkspaceTab } from '../lib/profileNavigation';
import { SegmentedControl } from './SegmentedControl';
import { PersonalityHomeDialog, type PersonalityHomeProfile } from './PersonalityHomeDialog';
import { MutualMarkDialog } from './MutualMarkDialog';
import { IntentProfileDialog } from './intentSense/IntentProfileDialog';
import { useIntentSenseStatus } from './intentSense/context';
import { usePersonRelationship } from '../lib/contactRelationship';

export function ContactWorkspace({
  contact,
  personalityProfile,
  tab,
  onTabChange,
  onNavigateAway,
  children,
}: {
  contact: Contact;
  personalityProfile: PersonalityHomeProfile;
  tab?: ContactWorkspaceTab;
  onTabChange?: (tab: ContactWorkspaceTab) => void;
  onNavigateAway: () => void;
  children: ReactNode;
}) {
  const [localTab, setLocalTab] = useState<ContactWorkspaceTab>('profile');
  const [tabsStuck, setTabsStuck] = useState(false);
  const workspace = useRef<HTMLDivElement>(null);
  const status = useIntentSenseStatus();
  const relationship = usePersonRelationship(contact);
  useEffect(() => setLocalTab('profile'), [contact.id]);
  const hasQQ =
    ['QQ', 'UIN'].includes(contact.identityLabel) && /^[1-9]\d{4,19}$/.test(contact.identityValue);
  const hasUid = /^u_[A-Za-z0-9_-]+$/.test(contact.uid || contact.id);
  const options = [
    {
      value: 'profile' as const,
      label: (
        <>
          <UserRound size={14} />
          资料
        </>
      ),
    },
    {
      value: 'personality' as const,
      label: (
        <>
          <Wand2 size={14} />
          个性主页
        </>
      ),
      disabled: !hasQQ && contact.kind !== 'bot',
      title: hasQQ || contact.kind === 'bot' ? undefined : '需要有效 QQ 号',
    },
    {
      value: 'marks' as const,
      label: (
        <>
          <Award size={14} />
          互动标识
        </>
      ),
      disabled: !hasQQ || contact.kind === 'bot' || relationship !== 'friend',
      title:
        contact.kind === 'bot'
          ? '机器人不提供互动标识'
          : relationship !== 'friend'
            ? '仅好友提供互动标识'
            : hasQQ
              ? undefined
              : '需要有效 QQ 号',
    },
    {
      value: 'portrait' as const,
      label: (
        <>
          <BrainCircuit size={14} />
          互动画像
        </>
      ),
      disabled: !hasUid,
      title: hasUid ? undefined : '需要有效用户 UID',
    },
  ];
  const requested = tab ?? localTab;
  const selected = options.some((option) => option.value === requested && !option.disabled)
    ? requested
    : 'profile';
  const select = onTabChange ?? setLocalTab;
  useEffect(() => {
    const scroller = workspace.current?.closest('.weq-contact-profile-content');
    if (scroller) scroller.scrollTop = 0;
  }, [selected, contact.id]);
  // 分区条只在真正吸住时才铺底色，避免和顶部标题栏叠成两层浮层。
  useEffect(() => {
    const root = workspace.current;
    const scroller = root?.closest<HTMLElement>('.weq-contact-profile-content');
    const tabs = root?.querySelector<HTMLElement>('.weq-contact-workspace-tabs');
    if (!scroller || !tabs) return;
    const update = () => {
      const edge = scroller.getBoundingClientRect().top;
      setTabsStuck(tabs.getBoundingClientRect().top <= edge + 1);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, []);
  return (
    <div className="weq-contact-workspace" ref={workspace}>
      <nav
        className={`weq-contact-workspace-tabs${tabsStuck ? ' is-stuck' : ''}`}
        aria-label="联系人详情分区"
      >
        <SegmentedControl
          label="联系人详情分区"
          value={selected}
          options={options}
          onChange={select}
        />
      </nav>
      <div className="weq-contact-tab-panel">
        {selected === 'profile' ? (
          children
        ) : selected === 'personality' ? (
          <PersonalityHomeDialog
            key={contact.id}
            embedded
            uin={contact.identityValue}
            uid={hasUid ? contact.uid || contact.id : undefined}
            profile={personalityProfile}
            isBot={contact.kind === 'bot'}
            spaceNickname={contact.nick || contact.displayName}
            onClose={onNavigateAway}
          />
        ) : selected === 'marks' ? (
          <MutualMarkDialog
            key={contact.id}
            embedded
            uin={contact.identityValue}
            name={contact.displayName}
            cachedMarks={contact.extInfo?.interactMarks}
            onClose={onNavigateAway}
          />
        ) : status.data?.profileEnabled ? (
          <IntentProfileDialog
            key={contact.id}
            embedded
            peerUid={contact.uid || contact.id}
            peerName={contact.displayName}
            onClose={onNavigateAway}
          />
        ) : (
          <p className="weq-contact-feature-state" role="status">
            {status.isLoading
              ? '正在读取互动画像状态…'
              : status.error
                ? `互动画像状态读取失败：${status.error.message}`
                : '互动画像未启用'}
          </p>
        )}
      </div>
    </div>
  );
}
