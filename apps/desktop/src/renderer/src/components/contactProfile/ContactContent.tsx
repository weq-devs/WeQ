import { useContext, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Building2 } from 'lucide-react';
import {
  occupationText,
  bloodTypeText,
  chineseZodiacText,
  profileTimeText,
} from '@weq/protocol/profile-values';
import type { ContactCardContent, ContactCardSettings } from '@weq/service/contact-card';
import { Avatar } from '../../im-template/template/primitives';
import type { Contact } from '../../im-template/template/types';
import { displayUserName } from '../../im-template/template/user';
import { copyTextToClipboard } from '../../im-template/template/clipboard';
import { contactAgeText, contactBirth } from '../../lib/contactBirth';
import { albumMediaUrl, collectionImageUrl, dressUrl } from '../../lib/resourceUrl';
import {
  ContactWorkspaceNavigationContext,
  type ContactWorkspaceTab,
} from '../../lib/profileNavigation';
import { relationMeta } from '../../lib/profileRelations';
import { usePersonRelationship, useGroupRelationship } from '../../lib/contactRelationship';
import { useCardDisplayNames } from '../../hooks/useCardDisplayNames';
import {
  PROFILE_QUERY_OPTIONS,
  useContactDress,
  useContactQqShow,
  useContactStats,
  type ProfilePerson,
} from '../../hooks/useContactCard';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { client, trpc } from '../../trpc/client';
import { PersonRelationshipStatus } from '../RelationshipStatus';
import { ContactBirthdayRow } from '../ContactBirthdayRow';
import { CommonRelationships } from '../qq-actions/CommonRelationships';
import { FriendClue } from '../qq-actions/FriendClue';
import { ProfileLikeAction } from '../qq-actions/ProfileLikeAction';
import { QQRemarkDialog } from '../QQRemarkDialog';
import { FriendDirectoryContext } from '../FriendDirectoryControls';
import { VirtualConversationBadge } from '../VirtualConversationAvatar';
import { QQGroupMemberControls } from '../QQGroupMemberControls';
import { openLightbox } from '../ImageLightbox';
import { QqShowGallery } from '../QqShowGallery';
import { ProfileExtraDialog, type ProfileExtraView } from '../ProfileExtras';
import '../../styles/contact-card.css';
const automaticFields: readonly ContactCardContent[] = [
  'qqShow',
  'labels',
  'common',
  'marks',
  'level',
  'likes',
  'energy',
  'company',
  'description',
  'email',
  'friendClue',
  'notes',
  'botDescription',
  'botFeatures',
];

export function ContactValue({
  label,
  children,
  onClick,
}: {
  label: string;
  children: ReactNode;
  onClick?: () => void;
}) {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="weq-profile-row">
      <span className="weq-profile-row-label">{label}</span>
      {onClick ? (
        <button
          type="button"
          className="weq-contact-value"
          data-privacy-sensitive
          onClick={(event) => {
            const selection = window.getSelection();
            if (!selection?.toString() || !event.currentTarget.contains(selection.anchorNode))
              onClick();
          }}
        >
          {children}
        </button>
      ) : (
        <span className="weq-profile-row-value" data-privacy-sensitive>
          {children}
        </span>
      )}
    </div>
  );
}
export function ContactIdentity({
  person,
  onOpen,
  pendant = false,
}: {
  person: ProfilePerson;
  onOpen?: () => void;
  pendant?: boolean;
}) {
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const relationship = usePersonRelationship(person);
  const names = useCardDisplayNames(
    'user',
    person.identityValue,
    !person.clone && ['QQ', 'UIN'].includes(person.identityLabel),
  );
  const name = person.clone
    ? displayUserName(person)
    : names?.name || person.nick?.trim() || person.identityValue || person.username;
  const remark = person.clone ? undefined : (names?.remark ?? person.remark);
  const identity = person.clone ? person.id.replace(/^virtual:/, '') : person.identityValue;
  return (
    <div className="weq-profile-hero weq-contact-identity" data-privacy-sensitive>
      <button
        type="button"
        className={`weq-profile-avatar${person.clone ? ' weq-clone-profile-avatar' : ''}`}
        title="查看头像"
        onClick={() => person.avatarUrl && openLightbox(person.avatarUrl, name)}
      >
        <Avatar name={name} avatarUrl={person.avatarUrl} seed={person.identityValue} />
        {person.clone ? <VirtualConversationBadge /> : null}
        {pendant && !person.clone && ['QQ', 'UIN'].includes(person.identityLabel) ? (
          <ContactPendant person={person} />
        ) : null}
      </button>
      <div className="weq-profile-heading">
        <button
          type="button"
          className="weq-profile-name weq-contact-value"
          aria-label={onOpen ? '联系人详情' : undefined}
          title={onOpen ? '联系人详情' : undefined}
          onClick={(event) => {
            const selection = window.getSelection();
            if (!selection?.toString() || !event.currentTarget.contains(selection.anchorNode))
              onOpen?.();
          }}
          disabled={!onOpen}
        >
          {name}
        </button>
        {!person.clone ? <PersonRelationshipStatus person={person} /> : null}
        {!person.clone && person.kind === 'bot' ? (
          <span className="weq-contact-identity-kind">
            <Bot size={13} />
            机器人
          </span>
        ) : null}
        {!person.clone && person.extInfo?.isEnterprise ? (
          <span className="weq-contact-identity-kind">
            <Building2 size={13} />
            企业用户
          </span>
        ) : null}
        <button
          type="button"
          className="weq-profile-id"
          title={copied ? '已复制' : '点击复制'}
          aria-label={person.clone ? '复制 ID' : undefined}
          onClick={() => void copyTextToClipboard(identity).then(setCopied)}
        >
          {person.clone ? 'ID' : person.identityLabel}{' '}
          <span className="weq-number">{identity}</span>
          {copied ? ' 已复制' : ''}
        </button>
        {!person.clone && relationship === 'friend' ? (
          <button
            type="button"
            className="weq-contact-value"
            disabled={!/^u_/.test(person.uid || person.id)}
            onClick={() => setRemarkOpen(true)}
          >
            {remark ? `备注 ${remark}` : '添加备注'}
          </button>
        ) : remark ? (
          <small>备注 {remark}</small>
        ) : null}
      </div>
      {remarkOpen && !person.clone && relationship === 'friend' ? (
        <QQRemarkDialog
          target={{ kind: 'c2c', conv: person.uid || person.id, name }}
          onClose={() => setRemarkOpen(false)}
        />
      ) : null}
    </div>
  );
}
function ContactPendant({ person }: { person: ProfilePerson }) {
  const result = useContactDress(person.identityValue, person.kind !== 'bot');
  const url = result.data?.widgetUrl;
  return url ? <img className="weq-contact-pendant" src={dressUrl(url)} alt="头像挂件" /> : null;
}
function CurrentShow({ person }: { person: ProfilePerson }) {
  const [open, setOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const query = useContactQqShow(person.identityValue);
  const url = query.data?.hasShow ? query.data.url : null;
  return (
    <>
      {url && failedUrl !== url ? (
        <button
          type="button"
          className="weq-contact-qqshow"
          title="查看 QQ 秀展柜"
          onClick={() => setOpen(true)}
        >
          <img src={dressUrl(url)} alt="当前 QQ 秀" onError={() => setFailedUrl(url)} />
        </button>
      ) : null}
      {open ? (
        <QqShowGallery
          uin={person.identityValue}
          name={displayUserName(person)}
          currentRevision={url ? Number(/\/(\d+)\.png/.exec(url)?.[1]) || null : null}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
function ContactStats({ person, field }: { person: ProfilePerson; field: 'level' | 'likeCount' }) {
  const uid = person.uid || person.id;
  const query = useContactStats(person.identityValue, uid, field);
  const value = query.data?.[field];
  return typeof value === 'number' ? (
    <ContactValue label={field === 'level' ? 'QQ 等级' : '累计获赞'}>
      {value.toLocaleString('zh-CN')}
    </ContactValue>
  ) : null;
}
function ExtraFields({
  person,
  enabled,
  onOpen,
}: {
  person: ProfilePerson;
  enabled: (field: ContactCardContent) => boolean;
  onOpen: () => void;
}) {
  const session = useQQWriteSession(`contact-details:${person.id}`, true);
  const query = trpc.account.profileExtras.details.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      uin: person.identityValue,
    },
    {
      ...PROFILE_QUERY_OPTIONS,
      enabled:
        session.available && (enabled('company') || enabled('description') || enabled('email')),
    },
  );
  const data = query.data?.targetUin === person.identityValue ? query.data : null;
  return (
    <>
      {enabled('company') ? (
        <ContactValue label="公司" onClick={onOpen}>
          {data?.company}
        </ContactValue>
      ) : null}
      {enabled('description') ? (
        <ContactValue label="个人说明" onClick={onOpen}>
          {data?.personalDescription}
        </ContactValue>
      ) : null}
      {enabled('email') ? (
        <ContactValue
          label="邮箱"
          onClick={() => data?.email && void copyTextToClipboard(data.email)}
        >
          {data?.email}
        </ContactValue>
      ) : null}
    </>
  );
}
function Energy({ person }: { person: ProfilePerson }) {
  const session = useQQWriteSession(`profile-extras:${person.identityValue}`, true);
  const query = trpc.account.profileExtras.energy.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      uin: person.identityValue,
    },
    { ...PROFILE_QUERY_OPTIONS, enabled: session.available },
  );
  return query.data?.targetUin === person.identityValue && query.data.score !== null ? (
    <ContactValue label="QQ 能量值">{query.data.score}</ContactValue>
  ) : null;
}
function Notes({ person, onEdit }: { person: ProfilePerson; onEdit: () => void }) {
  const session = useQQWriteSession(`contact-notes:${person.id}`, true);
  const query = trpc.account.qqWrite.friendNotesState.useQuery(
    { ...session.binding!, uid: person.uid || person.id },
    { ...PROFILE_QUERY_OPTIONS, enabled: session.available && /^u_/.test(person.uid || person.id) },
  );
  const notes = query.data;
  return notes ? (
    <ContactValue label="我的备注资料" onClick={onEdit}>
      {[notes.company, ...notes.phones, ...notes.descriptions].filter(Boolean).join(' · ') ||
        '添加备注资料'}
    </ContactValue>
  ) : null;
}
function Labels({ person, open }: { person: ProfilePerson; open: (id?: string) => void }) {
  const session = useQQWriteSession(`profile-extras:${person.identityValue}`, true);
  const query = trpc.account.profileExtras.personalityLabels.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      uin: person.identityValue,
    },
    { ...PROFILE_QUERY_OPTIONS, enabled: session.available },
  );
  const data = query.data?.targetUin === person.identityValue ? query.data : null;
  return (
    <div className="weq-profile-interests">
      {data
        ? data.labels.map((label) => (
            <button
              key={label.id}
              type="button"
              className="weq-profile-interest"
              onClick={() => open(label.id)}
            >
              {label.text}
            </button>
          ))
        : [...new Set(person.extInfo?.interests)].map((label) => (
            <button
              key={label}
              type="button"
              className="weq-profile-interest"
              onClick={() => open()}
            >
              {label}
            </button>
          ))}
    </div>
  );
}
function MarksSummary({ person, onOpen }: { person: ProfilePerson; onOpen: () => void }) {
  const session = useQQWriteSession(`contact-marks:${person.id}`, true);
  const query = trpc.account.mutualMark.get.useQuery(
    {
      uin: person.identityValue,
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    },
    { ...PROFILE_QUERY_OPTIONS, enabled: session.available },
  );
  const marks =
    query.data && !query.error
      ? query.data.categories
          .flatMap((category) => category.marks)
          .filter((mark) => mark.isLightup || mark.isWearing)
          .map((mark) => ({ id: mark.id, text: mark.name, icon: mark.iconUrl }))
      : (person.extInfo?.interactMarks ?? []).map((mark) => ({
          id: mark.markId,
          text: mark.type || `互动标识 ${mark.markId ?? ''}`,
          icon: mark.iconUrl,
        }));
  return (
    <div className="weq-profile-tags">
      {marks.map((mark) => (
        <button
          type="button"
          className="weq-contact-value"
          key={`${mark.id}:${mark.text}`}
          onClick={onOpen}
        >
          {mark.icon ? (
            <img width={22} height={22} src={collectionImageUrl(mark.icon)} alt="" />
          ) : null}
          {mark.text}
        </button>
      ))}
    </div>
  );
}
function BotFeatures({ person, description }: { person: ProfilePerson; description: boolean }) {
  const session = useQQWriteSession(`contact-bot:${person.id}`, true);
  const query = useQuery({
    queryKey: ['contact-bot', session.binding, person.uid || person.id],
    queryFn: () =>
      client.account.getBotProfile.query({ uid: person.uid || person.id, ...session.binding }),
    enabled: Boolean(session.binding),
    ...PROFILE_QUERY_OPTIONS,
  });
  const data = query.data;
  return description ? (
    <p className="weq-contact-text">{data?.description}</p>
  ) : (
    <>
      {data?.wakeCommand ? <ContactValue label="唤醒指令">{data.wakeCommand}</ContactValue> : null}
      {data?.welcome ? <ContactValue label="欢迎语">{data.welcome}</ContactValue> : null}
      {data?.commands.length ? (
        <details>
          <summary>机器人命令 · {data.commands.length}</summary>
          {data.commands.map((command) => (
            <p key={command.id}>
              <code>{command.command}</code> {command.description}
            </p>
          ))}
        </details>
      ) : null}
    </>
  );
}
function memberDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 2000
    ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : null;
}
export function ContactGroupContent({
  person,
  settings,
  full = false,
}: {
  person: ProfilePerson;
  settings: ContactCardSettings;
  full?: boolean;
}) {
  const context = person.profileContext;
  const relationship = useGroupRelationship({ id: context?.groupCode });
  if (!context) return null;
  const member = { ...person, ...context.member };
  const muted = member.muteUntil && new Date(member.muteUntil).getTime() > Date.now();
  const rows = {
    groupLevel: member.memberLevel
      ? `Lv.${member.memberLevel}${member.levelName ? ` · ${member.levelName}` : ''}`
      : member.levelName,
    joinedAt: member.joinedAt,
    lastSpeakAt: member.lastSpeakAt,
  };
  return (
    <section className="weq-contact-group-context" aria-label="群内资料">
      <h3>{context.groupName || context.groupCode}</h3>
      {relationship === 'nonmember' || member.leftGroup ? (
        <>
          <ContactValue label="群昵称">{member.card}</ContactValue>
          <ContactValue label="专属头衔">{member.customTitle}</ContactValue>
        </>
      ) : (
        <QQGroupMemberControls
          groupCode={context.groupCode}
          uid={person.uid || person.id}
          profile={{ card: member.card, title: member.customTitle ?? undefined }}
        />
      )}
      {member.role ? (
        <ContactValue label="群角色">
          {{ owner: '群主', admin: '管理员', member: '成员' }[member.role]}
        </ContactValue>
      ) : null}
      {member.leftGroup ? <p role="status">已退群</p> : null}
      {muted ? (
        <ContactValue label="禁言截止">
          {new Date(member.muteUntil!).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
        </ContactValue>
      ) : null}
      {settings.groupOrder
        .filter((key) => full || settings.visible[key])
        .map((key) => (
          <ContactValue
            key={key}
            label={{ groupLevel: '群等级', joinedAt: '入群时间', lastSpeakAt: '最后群发言' }[key]}
          >
            {key === 'groupLevel' ? rows[key] : memberDate(rows[key])}
          </ContactValue>
        ))}
    </section>
  );
}
export function ContactContent({
  person,
  settings,
  full = false,
  fields,
  onSection,
  onNavigate,
  localOnly = false,
}: {
  person: ProfilePerson;
  settings: ContactCardSettings;
  full?: boolean;
  fields?: ContactCardContent[];
  onSection?: (section: ContactWorkspaceTab, labelId?: string) => void;
  onNavigate?: () => void;
  localOnly?: boolean;
}) {
  const [detail, setDetail] = useState<{ view: ProfileExtraView; labelId?: string } | null>(null);
  const [remarkOpen, setRemarkOpen] = useState(false);
  const navigate = useContext(ContactWorkspaceNavigationContext);
  const friendDirectory = useContext(FriendDirectoryContext);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const relationship = usePersonRelationship(person);
  const enabled = (key: ContactCardContent) =>
    (!fields || fields.includes(key)) && (full || settings.visible[key]);
  const ext = person.extInfo;
  const birth = contactBirth(person);
  const hasQQ =
    ['QQ', 'UIN'].includes(person.identityLabel) && /^[1-9]\d{4,19}$/.test(person.identityValue);
  const personal = !person.clone && person.kind !== 'bot' && !ext?.isEnterprise && hasQQ;
  function open(view: ProfileExtraView, labelId?: string) {
    if (onSection) onSection(view === 'education' ? 'details' : view, labelId);
    else setDetail({ view, labelId });
  }
  const rows: Partial<Record<ContactCardContent, ReactNode>> = {
    qqShow:
      hasQQ && !person.clone && person.kind !== 'bot' ? <CurrentShow person={person} /> : null,
    signature: person.signature ? (
      <details className="weq-contact-signature">
        <summary
          onClick={(event) => {
            const selection = window.getSelection();
            if (selection?.toString() && event.currentTarget.contains(selection.anchorNode))
              event.preventDefault();
          }}
        >
          {person.signature}
        </summary>
        <p>{person.signature}</p>
      </details>
    ) : null,
    signatureUpdated: profileTimeText(person.sigUpdateTime) ? (
      <ContactValue label="签名更新时间">{profileTimeText(person.sigUpdateTime)}</ContactValue>
    ) : null,
    gender: (
      <ContactValue label="性别">
        {person.gender === 1 ? '男' : person.gender === 2 ? '女' : null}
      </ContactValue>
    ),
    age: <ContactValue label="年龄">{contactAgeText(person)}</ContactValue>,
    birthday: <ContactBirthdayRow birth={birth} />,
    constellation: <ContactValue label="星座">{birth.constellation?.name}</ContactValue>,
    zodiac: <ContactValue label="生肖">{chineseZodiacText(ext?.zodiac)}</ContactValue>,
    bloodType: <ContactValue label="血型">{bloodTypeText(ext?.bloodType)}</ContactValue>,
    occupation: <ContactValue label="职业">{occupationText(ext?.occupation)}</ContactValue>,
    region: (
      <ContactValue label="所在地">
        {[...new Set([ext?.country, ext?.province, ext?.city].filter(Boolean))].join(' · ')}
      </ContactValue>
    ),
    school: (
      <ContactValue label="学校" onClick={() => open('education')}>
        {[ext?.school, ext?.degree].filter(Boolean).join(' · ')}
      </ContactValue>
    ),
    labels: personal ? <Labels person={person} open={(id) => open('labels', id)} /> : null,
    photos: (
      <div className="weq-profile-album">
        {ext?.album.map((photo, index) => {
          const url = photo.urls.find((item) => item.url)?.url;
          return url ? (
            <button
              type="button"
              key={photo.photoId ?? index}
              className="weq-profile-photo"
              title="查看精选图片"
              onClick={() => openLightbox(albumMediaUrl(url), '精选图片')}
            >
              <img src={albumMediaUrl(url)} alt="精选图片" loading="lazy" />
            </button>
          ) : null;
        })}
      </div>
    ),
    status: <ContactValue label="状态">{person.customStatus || person.onlineStatus}</ContactValue>,
    common:
      personal && relationship !== 'self' ? (
        <CommonRelationships uin={person.identityValue} onNavigate={onNavigate} />
      ) : null,
    category: (
      <ContactValue
        label="好友分组"
        onClick={
          relationship === 'friend' && friendDirectory?.available
            ? () => friendDirectory.move([person.uid || person.id])
            : undefined
        }
      >
        {person.categoryName}
      </ContactValue>
    ),
    intimacy: person.intimacy ? (
      <ContactValue label="QQ 亲密度">{person.intimacy}</ContactValue>
    ) : null,
    relations: (
      <div className="weq-profile-tags">
        {[
          ...new Set([
            person.extRelation?.displayId,
            ...(person.extRelation?.preselectedIds ?? []),
          ]),
        ]
          .filter((id): id is number => id !== undefined)
          .map((id) => (
            <span className="weq-profile-tag" key={id}>
              {relationMeta(id).label}
            </span>
          ))}
      </div>
    ),
    marks:
      personal && relationship === 'friend' ? (
        <MarksSummary
          person={person}
          onOpen={() =>
            onSection
              ? onSection('marks')
              : navigate?.({
                  kind: 'person',
                  contact: { createdAt: '', ...person } as Contact,
                  tab: 'marks',
                })
          }
        />
      ) : null,
    privileges: (
      <div className="weq-profile-privileges">
        {ext?.privileges
          .filter((item) => item.opened && item.iconUrl)
          .map((item) => (
            <img
              key={`${item.bizId}:${item.iconUrl}:${item.level}`}
              src={collectionImageUrl(item.iconUrl!)}
              alt={`特权 ${item.bizId ?? ''}`}
              title={`特权 ${item.bizId ?? ''}${item.level ? ` · ${item.level} 级` : ''}`}
              loading="lazy"
            />
          ))}
      </div>
    ),
    level:
      hasQQ && !person.clone && person.kind !== 'bot' ? (
        <ContactStats person={person} field="level" />
      ) : null,
    likes: personal ? <ContactStats person={person} field="likeCount" /> : null,
    energy: personal ? <Energy person={person} /> : null,
    qid: (
      <ContactValue label="QID" onClick={() => person.qid && void copyTextToClipboard(person.qid)}>
        {person.qid}
      </ContactValue>
    ),
    uid: (
      <ContactValue
        label="NT UID"
        onClick={() => void copyTextToClipboard(person.uid || person.id)}
      >
        {/^u_/.test(person.uid || person.id) ? person.uid || person.id : null}
      </ContactValue>
    ),
    friendClue:
      personal && relationship === 'friend' ? <FriendClue uid={person.uid || person.id} /> : null,
    notes:
      personal && relationship === 'friend' ? (
        <Notes person={person} onEdit={() => setRemarkOpen(true)} />
      ) : null,
    botDescription: person.kind === 'bot' ? <BotFeatures person={person} description /> : null,
    botFeatures: person.kind === 'bot' ? <BotFeatures person={person} description={false} /> : null,
  };
  return (
    <>
      <div className="weq-profile-list weq-contact-content">
        {settings.order
          .filter((key) => enabled(key) && (!localOnly || !automaticFields.includes(key)))
          .map((key) =>
            key === 'company' || key === 'description' || key === 'email' ? (
              personal ? (
                <div key={key} data-profile-field={key}>
                  <ExtraFields
                    person={person}
                    enabled={(field) => field === key}
                    onOpen={() => open('details')}
                  />
                </div>
              ) : null
            ) : key === 'pendant' ? null : (
              <div key={key} data-profile-field={key}>
                {rows[key]}
              </div>
            ),
          )}
      </div>
      {personal ? (
        <nav className="weq-contact-more" aria-label="更多资料">
          <button type="button" onClick={() => open('details')}>
            详细资料
          </button>
          <button type="button" onClick={() => open('education')}>
            教育经历
          </button>
          <button type="button" onClick={() => open('signatures')}>
            历史签名
          </button>
          <button type="button" onClick={() => open('questions')}>
            匿问我答
          </button>
          <button type="button" onClick={() => setGalleryOpen(true)}>
            QQ 秀展柜
          </button>
          {relationship === 'friend' ? (
            <button
              type="button"
              disabled={!/^u_/.test(person.uid || person.id)}
              onClick={() => setRemarkOpen(true)}
            >
              我的备注资料
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              onSection
                ? onSection('history')
                : navigate?.({
                    kind: 'person',
                    contact: { createdAt: '', ...person } as Contact,
                    tab: 'history',
                  })
            }
          >
            资料历史
          </button>
          <ProfileLikeAction
            uid={person.uid || person.id}
            uin={person.identityValue}
            name={displayUserName(person)}
          />
        </nav>
      ) : null}
      {detail && personal ? (
        <ProfileExtraDialog
          uin={person.identityValue}
          {...detail}
          onClose={() => setDetail(null)}
        />
      ) : null}
      {galleryOpen && !person.clone && person.kind !== 'bot' ? (
        <QqShowGallery
          uin={person.identityValue}
          name={displayUserName(person)}
          currentRevision={null}
          onClose={() => setGalleryOpen(false)}
        />
      ) : null}
      {remarkOpen && personal && relationship === 'friend' ? (
        <QQRemarkDialog
          target={{ kind: 'c2c', conv: person.uid || person.id, name: displayUserName(person) }}
          showNotes
          onClose={() => setRemarkOpen(false)}
        />
      ) : null}
    </>
  );
}
