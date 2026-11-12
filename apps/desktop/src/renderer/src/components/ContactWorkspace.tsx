import { useState, type ReactNode } from 'react';
import { DEFAULT_CONTACT_CARD, type ContactCardContent } from '@weq/service/contact-card';
import type { Contact } from '../im-template/template/types';
import type { ContactWorkspaceTab } from '../lib/profileNavigation';
import {
  CONTACT_WORKSPACE_SECTIONS,
  contactWorkspaceSection,
  type ContactWorkspaceSection,
} from '../lib/contactWorkspace';
import { PersonalityHomeDialog, type PersonalityHomeProfile } from './PersonalityHomeDialog';
import { MutualMarkDialog } from './MutualMarkDialog';
import { IntentProfileDialog } from './intentSense/IntentProfileDialog';
import { useIntentSenseStatus } from './intentSense/context';
import { usePersonRelationship } from '../lib/contactRelationship';
import { ContactHistory } from './ContactHistory';
import { ContactContent } from './contactProfile/ContactContent';
import { ContactGroupWorkspace } from './contactProfile/ContactGroupWorkspace';
import { ProfileDisclosure } from './contactProfile/ProfileDisclosure';
import { ContactSection, ContactTechnicalDetails, ContactRow } from './contactProfile/ContactRow';
import { ProfileExtrasContent } from './ProfileExtras';
import { SelfQQControls } from './settings/SelfQQControls';
import { SelfAvatarHistory } from './SelfAvatarHistory';
import { ProfileWorkspace } from './ProfileWorkspace';
import '../styles/contact-card.css';
import '../styles/contact-workspace.css';

export function ContactWorkspace({
  contact,
  personalityProfile,
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
  const hasQQ =
    ['QQ', 'UIN'].includes(contact.identityLabel) &&
    /^[1-9]\d{4,19}$/.test(contact.identityValue) &&
    !contact.clone;
  const hasUid = /^u_/.test(contact.uid || contact.id) && !contact.clone;
  const human = hasQQ && contact.kind !== 'bot' && !contact.extInfo?.isEnterprise;
  const options = CONTACT_WORKSPACE_SECTIONS.filter(
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
  const entity = `friend:${contact.uid || (hasQQ ? contact.identityValue : contact.id)}`;
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
  function history(section: ContactWorkspaceSection, title = '资料变更记录') {
    return hasQQ || hasUid ? (
      <ProfileDisclosure
        title={title}
        initiallyOpen={section === 'profile' && opened === 'history'}
        openRequest={openRequest}
      >
        <ContactHistory entity={entity} section={section} />
      </ProfileDisclosure>
    ) : null;
  }
  function panel(key: ContactWorkspaceSection) {
    if (key === 'profile')
      return (
        <>
          {relationship === 'self' ? (
            <ProfileDisclosure
              title="编辑资料与展示设置"
              initiallyOpen={opened === 'edit'}
              openRequest={openRequest}
            >
              <SelfQQControls />
            </ProfileDisclosure>
          ) : null}
          {content([
            'signature',
            'signatureUpdated',
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
          {human ? (
            <>
              <ProfileDisclosure
                title="教育经历"
                initiallyOpen={opened === 'details'}
                openRequest={openRequest}
              >
                <ProfileExtrasContent uin={contact.identityValue} view="education" />
              </ProfileDisclosure>
              <ProfileDisclosure
                title="签名历史"
                initiallyOpen={opened === 'signatures'}
                openRequest={openRequest}
              >
                <ProfileExtrasContent uin={contact.identityValue} view="signatures" />
              </ProfileDisclosure>
            </>
          ) : null}
          {relationship === 'self' ? (
            <ContactSection title="头像">
              <SelfAvatarHistory />
            </ContactSection>
          ) : null}
          {history('profile')}
          {hasUid ? (
            <ContactTechnicalDetails>
              <ContactRow
                label="UID"
                value={contact.uid || contact.id}
                copyValue={contact.uid || contact.id}
                mono
                activateTitle="复制 UID"
              />
            </ContactTechnicalDetails>
          ) : null}
        </>
      );
    if (key === 'marks')
      return (
        <>
          {content(['common', 'intimacy', 'relations', 'friendClue'])}
          {human && relationship === 'friend' ? (
            <ContactSection title="互动标识">
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
            <ProfileDisclosure
              title="互动画像"
              initiallyOpen={opened === 'portrait'}
              openRequest={openRequest}
            >
              <Portrait contact={contact} />
            </ProfileDisclosure>
          ) : null}
          {history('marks', '关系变更记录')}
        </>
      );
    if (key === 'group')
      return (
        <>
          <ContactGroupWorkspace contact={contact} />
          {history('group', '所在群历史')}
        </>
      );
    return (
      <>
        {content(['labels', 'photos', 'qqShow'])}
        {hasQQ ? (
          <ProfileDisclosure title="个性装扮">
            <PersonalityHomeDialog
              embedded
              uin={contact.identityValue}
              uid={hasUid ? contact.uid || contact.id : undefined}
              profile={personalityProfile}
              isBot={contact.kind === 'bot'}
              spaceNickname={contact.nick || contact.displayName}
              onClose={onNavigateAway}
            />
          </ProfileDisclosure>
        ) : null}
        {human ? (
          <ProfileDisclosure
            title="匿问我答"
            initiallyOpen={opened === 'questions'}
            openRequest={openRequest}
          >
            <ProfileExtrasContent uin={contact.identityValue} view="questions" />
          </ProfileDisclosure>
        ) : null}
        {history('personality', '个性展示变更记录')}
      </>
    );
  }
  return (
    <ProfileWorkspace
      label="联系人详情分区"
      sections={options}
      selected={selected}
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
