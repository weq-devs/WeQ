import { useState, type ReactNode } from 'react';
import { DEFAULT_CONTACT_CARD, type ContactCardContent } from '@weq/service/contact-card';
import type { Contact } from '../im-template/template/types';
import type { ContactWorkspaceTab } from '../lib/profileNavigation';
import {
  CONTACT_WORKSPACE_SECTIONS,
  SELF_WORKSPACE_SECTIONS,
  contactWorkspaceSection,
  type ContactWorkspaceSection,
} from '../lib/contactWorkspace';
import type { PersonalityHomeProfile } from './PersonalityHomeDialog';
import { MutualMarkDialog } from './MutualMarkDialog';
import { IntentProfileDialog } from './intentSense/IntentProfileDialog';
import { useIntentSenseStatus } from './intentSense/context';
import { usePersonRelationship } from '../lib/contactRelationship';
import { ContactContent } from './contactProfile/ContactContent';
import { ContactGroupWorkspace } from './contactProfile/ContactGroupWorkspace';
import { ProfileDisclosure } from './contactProfile/ProfileDisclosure';
import { ContactSection } from './contactProfile/ContactRow';
import { ProfileExtrasContent } from './ProfileExtras';
import { useSelfProfileFields } from './SelfProfileFields';
import { ProfileDisplayEntry, ProfileDisplaySettingField } from './ProfileDisplaySettings';
import { ProfileWorkspace } from './ProfileWorkspace';
import { ContactDressRow } from './contactProfile/ContactDressRow';
import { GiftWall } from './gift/GiftWall';
import '../styles/contact-card.css';
import '../styles/contact-workspace.css';

export function ContactWorkspace({
  contact,
  tab,
  onTabChange,
  onNavigateAway,
}: {
  contact: Contact;
  personalityProfile: PersonalityHomeProfile;
  tab?: ContactWorkspaceTab;
  onTabChange?: (tab: ContactWorkspaceTab) => void;
  onNavigateAway: () => void;
  children?: ReactNode;
}) {
  const [localTab, setLocalTab] = useState<ContactWorkspaceTab>('profile');
  const [detail, setDetail] = useState<ContactWorkspaceTab | null>(null);
  const [openRequest, setOpenRequest] = useState(0);
  const relationship = usePersonRelationship(contact);
  const self = useSelfProfileFields();
  const hasQQ =
    ['QQ', 'UIN'].includes(contact.identityLabel) &&
    /^[1-9]\d{4,19}$/.test(contact.identityValue) &&
    !contact.clone;
  const hasUid = /^u_/.test(contact.uid || contact.id) && !contact.clone;
  const human = hasQQ && contact.kind !== 'bot' && !contact.extInfo?.isEnterprise;
  const isSelf = relationship === 'self';
  const sections = isSelf ? SELF_WORKSPACE_SECTIONS : CONTACT_WORKSPACE_SECTIONS;
  const options = sections.filter(
    ([key]) => key !== 'group' || hasUid || Boolean(contact.profileContext),
  );
  const requested = tab ?? localTab;
  const target = contactWorkspaceSection(requested);
  const selected = options.some(([key]) => key === target) ? target : 'profile';
  function select(key: ContactWorkspaceTab) {
    setOpenRequest((value) => value + 1);
    setDetail(key);
    setLocalTab(key);
    onTabChange?.(key);
  }
  const opened = detail ?? requested;
  function content(fields: ContactCardContent[]) {
    return (
      <ContactContent
        person={contact}
        settings={DEFAULT_CONTACT_CARD}
        full
        technicalDetails={false}
        fields={fields}
        onSection={select}
      />
    );
  }
  function panel(key: ContactWorkspaceSection) {
    if (key === 'giftwall') return isSelf ? <GiftWall /> : null;
    if (key === 'profile')
      return (
        <>
          {self?.feedback}
          {content([
            'gender',
            'age',
            'birthday',
            'constellation',
            'zodiac',
            'bloodType',
            'region',
            'occupation',
            'school',
            'company',
            'description',
            'email',
            'level',
            'likes',
            'privileges',
            'energy',
            'botDescription',
            'botFeatures',
          ])}
        </>
      );
    if (key === 'marks')
      return (
        <>
          {content(['common', 'intimacy', 'relations', 'friendClue'])}
          {human && relationship === 'friend' ? (
            <ContactSection title="互动标识" prominent>
              <MutualMarkDialog
                embedded
                uin={contact.identityValue}
                name={contact.displayName}
                cachedMarks={contact.extInfo?.interactMarks}
                onClose={onNavigateAway}
              />
            </ContactSection>
          ) : null}
          {hasUid ? (
            <ContactSection title="互动画像" prominent anchor="portrait">
              <Portrait contact={contact} />
            </ContactSection>
          ) : null}
        </>
      );
    if (key === 'group') return <ContactGroupWorkspace contact={contact} />;
    return (
      <>
        {content(['qqShow', 'labels', 'photos'])}
        {hasQQ && contact.kind !== 'bot' ? <ContactDressRow person={contact} /> : null}
        {human ? (
          <ProfileDisplayEntry field="anonymousQuestions" unframed>
            <ProfileDisclosure
              title="匿问我答"
              initiallyOpen={opened === 'questions'}
              openRequest={openRequest}
            >
              {self ? <ProfileDisplaySettingField field="anonymousQuestions" /> : null}
              <ProfileExtrasContent uin={contact.identityValue} view="questions" />
            </ProfileDisclosure>
          </ProfileDisplayEntry>
        ) : null}
      </>
    );
  }
  return (
    <ProfileWorkspace
      showTitle={false}
      label={isSelf ? '我的资料分区' : '联系人详情分区'}
      sections={options}
      selected={selected}
      scrollTarget={requested === 'portrait' ? 'portrait' : undefined}
      onSelect={select}
      render={panel}
    />
  );
}

function Portrait({ contact }: { contact: Contact }) {
  const status = useIntentSenseStatus();
  return status.data?.profileEnabled ? (
    <IntentProfileDialog
      embedded
      peerUid={contact.uid || contact.id}
      peerName={contact.displayName}
      onClose={() => {}}
    />
  ) : (
    <p role="status">
      {status.isLoading
        ? '正在读取互动画像状态…'
        : status.error
          ? `互动画像状态读取失败：${status.error.message}`
          : '互动画像未启用'}
    </p>
  );
}
