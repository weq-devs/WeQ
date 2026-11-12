import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_CONTACT_CARD } from '@weq/service/contact-card';
import type { Contact } from '../im-template/template/types';
import type { ContactWorkspaceTab } from '../lib/profileNavigation';
import { PersonalityHomeDialog, type PersonalityHomeProfile } from './PersonalityHomeDialog';
import { MutualMarkDialog } from './MutualMarkDialog';
import { IntentProfileDialog } from './intentSense/IntentProfileDialog';
import { useIntentSenseStatus } from './intentSense/context';
import { usePersonRelationship } from '../lib/contactRelationship';
import { ContactHistory } from './ContactHistory';
import { ContactContent, ContactGroupContent } from './contactProfile/ContactContent';
import { EducationSection, ProfileExtrasContent } from './ProfileExtras';
import { ProfileDetailsSection } from './ProfileDetailsEntry';
import { SelfQQControls } from './settings/SelfQQControls';
import { ProfileWorkspace } from './ProfileWorkspace';
import '../styles/contact-card.css';

const sections: Array<[ContactWorkspaceTab, string]> = [
  ['profile', '概览'],
  ['details', '详细资料'],
  ['signatures', '签名历史'],
  ['labels', '标签相册'],
  ['questions', '匿问我答'],
  ['marks', '关系与互动'],
  ['group', '群内资料'],
  ['personality', '个性主页'],
  ['portrait', '互动画像'],
  ['history', '资料历史'],
  ['edit', '编辑资料'],
];
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
  const [labelId, setLabelId] = useState(contact.profileLabelId);
  useEffect(() => setLabelId(contact.profileLabelId), [contact.profileLabelId]);
  const relationship = usePersonRelationship(contact);
  const hasQQ =
    ['QQ', 'UIN'].includes(contact.identityLabel) &&
    /^[1-9]\d{4,19}$/.test(contact.identityValue) &&
    !contact.clone;
  const hasUid = /^u_/.test(contact.uid || contact.id) && !contact.clone;
  const human = hasQQ && contact.kind !== 'bot' && !contact.extInfo?.isEnterprise;
  const options = sections.filter(([key]) => {
    if (key === 'edit') return relationship === 'self';
    if (key === 'group') return Boolean(contact.profileContext) && !contact.clone;
    if (['labels', 'questions', 'signatures'].includes(key)) return human;
    if (key === 'personality') return hasQQ;
    if (key === 'portrait') return hasUid;
    if (key === 'history') return hasUid || hasQQ;
    return true;
  });
  const requested = tab ?? localTab;
  const selected = options.some(([key]) => key === requested) ? requested : 'profile';
  function select(key: ContactWorkspaceTab, label?: string) {
    setLabelId(label);
    setLocalTab(key);
    onTabChange?.(key);
  }
  function panel(key: ContactWorkspaceTab) {
    if (key === 'history')
      return (
        <ContactHistory
          entity={`friend:${contact.uid || (hasQQ ? contact.identityValue : contact.id)}`}
        />
      );
    if (key === 'profile')
      return (
        <ContactContent
          person={contact}
          settings={DEFAULT_CONTACT_CARD}
          full
          fields={[
            'signature',
            'gender',
            'age',
            'birthday',
            'region',
            'school',
            'labels',
            'status',
            'relations',
            'level',
            'qid',
            'company',
            'privileges',
            'botDescription',
          ]}
          onSection={select}
        />
      );
    if (key === 'details')
      return (
        <>
          <ContactContent
            person={contact}
            settings={DEFAULT_CONTACT_CARD}
            full
            fields={[
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
              'energy',
              'qid',
              'uid',
              'botDescription',
              'botFeatures',
            ]}
            onSection={select}
          />
          {human ? (
            <>
              {/* 扩展资料与教育经历共用 ContactRow 行模型，分区标题与刷新动作由分区自己输出。 */}
              <ProfileDetailsSection uin={contact.identityValue} />
              <EducationSection uin={contact.identityValue} />
            </>
          ) : null}
        </>
      );
    if (key === 'signatures' || key === 'labels' || key === 'questions')
      return (
        <ProfileExtrasContent
          uin={contact.identityValue}
          view={key}
          labelId={key === 'labels' ? labelId : undefined}
        />
      );
    if (key === 'group')
      return <ContactGroupContent person={contact} settings={DEFAULT_CONTACT_CARD} full />;
    if (key === 'edit') return <SelfQQControls />;
    if (key === 'personality')
      return (
        <PersonalityHomeDialog
          embedded
          uin={contact.identityValue}
          uid={hasUid ? contact.uid || contact.id : undefined}
          profile={personalityProfile}
          isBot={contact.kind === 'bot'}
          spaceNickname={contact.nick || contact.displayName}
          onClose={onNavigateAway}
        />
      );
    if (key === 'marks')
      return (
        <>
          <ContactContent
            person={contact}
            settings={DEFAULT_CONTACT_CARD}
            full
            fields={[
              'common',
              'category',
              'intimacy',
              'relations',
              'privileges',
              'likes',
              'friendClue',
              'notes',
            ]}
            onSection={select}
          />
          {human && relationship === 'friend' ? (
            <MutualMarkDialog
              embedded
              uin={contact.identityValue}
              name={contact.displayName}
              cachedMarks={contact.extInfo?.interactMarks}
              onClose={onNavigateAway}
            />
          ) : null}
        </>
      );
    return <Portrait contact={contact} />;
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
