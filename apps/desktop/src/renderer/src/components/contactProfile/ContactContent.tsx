import { Fragment, useContext, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, Building2, ChevronDown } from 'lucide-react';
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
import { contactBirth } from '../../lib/contactBirth';
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
import { QQRemarkDialog } from '../QQRemarkDialog';
import { FriendDirectoryContext } from '../FriendDirectoryControls';
import { VirtualConversationBadge } from '../VirtualConversationAvatar';
import { QQGroupMemberControls } from '../QQGroupMemberControls';
import { openLightbox } from '../ImageLightbox';
import { QqShowGallery } from '../QqShowGallery';
import { ProfileExtraDialog, type ProfileExtraView } from '../ProfileExtras';
import {
  ContactEmptyState,
  ContactInlineError,
  ContactRow,
  ContactSection,
  ContactTechnicalDetails,
} from './ContactRow';
import '../../styles/contact-card.css';

/**
 * 名片正文的分区归属。顺序仍由用户设置在 `settings.order` 里决定，
 * 这里只负责把同一类字段归到同一小节，避免一长串没有层级的数据行。
 */
const _BASIC_FIELDS: readonly ContactCardContent[] = [
  'qqShow',
  'pendant',
  'signature',
  'signatureUpdated',
  'gender',
  'age',
  'birthday',
  'constellation',
  'zodiac',
  'bloodType',
  'occupation',
  'region',
  'school',
  'labels',
  'photos',
  'status',
  'company',
  'description',
  'email',
  'energy',
];
const SOCIAL_FIELDS: readonly ContactCardContent[] = [
  'common',
  'category',
  'intimacy',
  'relations',
  'privileges',
  'level',
  'likes',
  'marks',
  'friendClue',
  'notes',
];
const BOT_FIELDS: readonly ContactCardContent[] = ['botDescription', 'botFeatures'];
/** 协议字段不参与名片正文，只在资料页「技术详情」折叠区出现。 */
const TECH_FIELDS: readonly ContactCardContent[] = ['qid', 'uid'];
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

export type ContactCardGroup = 'basic' | 'social' | 'bot' | 'tech';

/** 名片正文分区：名片、设置页字段分组、资料页都按同一份归属走。 */
export function contactCardFieldGroup(key: ContactCardContent): ContactCardGroup {
  if (TECH_FIELDS.includes(key)) return 'tech';
  if (BOT_FIELDS.includes(key)) return 'bot';
  if (SOCIAL_FIELDS.includes(key)) return 'social';
  return 'basic';
}

/** 标题、副标题、编号与关系：名片和资料页共用同一份身份区。 */
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
  const remark = person.clone ? undefined : (names?.remark ?? person.remark)?.trim();
  // 主标题必须是真实昵称（云端昵称 → 本地昵称 → 身份），备注单独展示，不顶替标题。
  const title = person.clone
    ? person.displayName
    : names?.name || person.nick?.trim() || person.identityValue || person.username;
  const identity = person.clone ? person.id.replace(/^virtual:/, '') : person.identityValue;
  const identityLabel = person.clone ? 'ID' : person.identityLabel;
  return (
    <div className="weq-profile-hero weq-contact-identity" data-privacy-sensitive>
      <button
        type="button"
        className={`weq-profile-avatar${person.clone ? ' weq-clone-profile-avatar' : ''}`}
        title="查看头像"
        aria-label="查看头像"
        onClick={() => person.avatarUrl && openLightbox(person.avatarUrl, title)}
      >
        <Avatar name={title} avatarUrl={person.avatarUrl} seed={person.identityValue} />
        {person.clone ? <VirtualConversationBadge /> : null}
        {pendant && !person.clone && ['QQ', 'UIN'].includes(person.identityLabel) ? (
          <ContactPendant person={person} />
        ) : null}
      </button>
      <div className="weq-profile-heading">
        <button
          type="button"
          className="weq-profile-name weq-contact-name"
          aria-label={onOpen ? '联系人详情' : undefined}
          title={onOpen ? '联系人详情' : undefined}
          disabled={!onOpen}
          onClick={(event) => {
            const selection = window.getSelection();
            if (!selection?.toString() || !event.currentTarget.contains(selection.anchorNode))
              onOpen?.();
          }}
        >
          {title}
        </button>
        <div className="weq-contact-meta">
          {!person.clone ? <PersonRelationshipStatus person={person} /> : null}
          {!person.clone && person.kind === 'bot' ? (
            <span className="weq-contact-identity-kind">
              <Bot size={12} />
              机器人
            </span>
          ) : null}
          {!person.clone && person.extInfo?.isEnterprise ? (
            <span className="weq-contact-identity-kind">
              <Building2 size={12} />
              企业用户
            </span>
          ) : null}
          {relationship !== 'friend' && remark ? (
            <span className="weq-contact-identity-kind">备注 {remark}</span>
          ) : null}
        </div>
        <div className="weq-contact-meta">
          <button
            type="button"
            className="weq-contact-number"
            title={copied ? '已复制' : '复制号码'}
            aria-label={person.clone ? '复制 ID' : `复制 ${identityLabel} 号码`}
            onClick={() => void copyTextToClipboard(identity).then(setCopied)}
          >
            {identityLabel} <span className="weq-number">{identity}</span>
            {copied ? ' 已复制' : ''}
          </button>
          {relationship === 'friend' && !person.clone ? (
            <button
              type="button"
              className="weq-contact-number"
              disabled={!/^u_/.test(person.uid || person.id)}
              onClick={() => setRemarkOpen(true)}
            >
              {remark ? `备注 ${remark}` : '添加备注'}
            </button>
          ) : null}
        </div>
      </div>
      {remarkOpen && !person.clone && relationship === 'friend' ? (
        <QQRemarkDialog
          target={{ kind: 'c2c', conv: person.uid || person.id, name: title }}
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

function QqShowRow({ person }: { person: ProfilePerson }) {
  const [open, setOpen] = useState(false);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const query = useContactQqShow(person.identityValue);
  const url = query.data?.hasShow ? query.data.url : null;
  if (!url || failedUrl === url) return null;
  return (
    <>
      <ContactRow label="QQ 秀">
        <button
          type="button"
          className="weq-contact-qqshow"
          title="查看 QQ 秀展柜"
          aria-label="查看 QQ 秀展柜"
          onClick={() => setOpen(true)}
        >
          <img src={dressUrl(url)} alt="当前 QQ 秀" onError={() => setFailedUrl(url)} />
        </button>
      </ContactRow>
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
    <ContactRow
      label={field === 'level' ? 'QQ 等级' : '累计获赞'}
      value={value.toLocaleString('zh-CN')}
    />
  ) : null;
}

function ExtraField({
  person,
  field,
  onOpen,
}: {
  person: ProfilePerson;
  field: 'company' | 'description' | 'email';
  onOpen: () => void;
}) {
  const session = useQQWriteSession(`contact-details:${person.id}`, true);
  const query = trpc.account.profileExtras.details.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      uin: person.identityValue,
    },
    { ...PROFILE_QUERY_OPTIONS, enabled: session.available },
  );
  const data = query.data?.targetUin === person.identityValue ? query.data : null;
  if (field === 'company')
    return (
      <ContactRow
        label="公司"
        value={data?.company}
        onActivate={onOpen}
        activateTitle="查看详细资料"
      />
    );
  if (field === 'description')
    return (
      <ContactRow label="个人说明" onActivate={onOpen} activateTitle="查看详细资料">
        <span className="weq-contact-clamp">{data?.personalDescription}</span>
      </ContactRow>
    );
  return (
    <ContactRow
      label="邮箱"
      value={data?.email}
      onActivate={() => data?.email && void copyTextToClipboard(data.email)}
      activateTitle="复制邮箱"
    />
  );
}

function EnergyRow({ person }: { person: ProfilePerson }) {
  const session = useQQWriteSession(`profile-extras:${person.identityValue}`, true);
  const query = trpc.account.profileExtras.energy.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
      uin: person.identityValue,
    },
    { ...PROFILE_QUERY_OPTIONS, enabled: session.available },
  );
  const score = query.data?.targetUin === person.identityValue ? query.data.score : null;
  return typeof score === 'number' ? <ContactRow label="QQ 能量值" value={score} /> : null;
}

function NotesRow({ person, onEdit }: { person: ProfilePerson; onEdit: () => void }) {
  const session = useQQWriteSession(`contact-notes:${person.id}`, true);
  const query = trpc.account.qqWrite.friendNotesState.useQuery(
    { ...session.binding!, uid: person.uid || person.id },
    { ...PROFILE_QUERY_OPTIONS, enabled: session.available && /^u_/.test(person.uid || person.id) },
  );
  const notes = query.data;
  if (!notes) return null;
  const text = [notes.company, ...notes.phones, ...notes.descriptions].filter(Boolean).join(' · ');
  return (
    <ContactRow
      label="我的备注资料"
      value={text || '添加备注资料'}
      onActivate={onEdit}
      activateTitle="编辑备注资料"
    />
  );
}

function LabelsRow({ person, open }: { person: ProfilePerson; open: (id?: string) => void }) {
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
  const fallback = [...new Set(person.extInfo?.interests ?? [])];
  const items = data
    ? data.labels.map((label) => ({ key: label.id, text: label.text, labelId: label.id }))
    : fallback.map((text) => ({ key: text, text, labelId: undefined }));
  if (!items.length) return null;
  return (
    <>
      <ContactRow label="标签">
        <div className="weq-profile-tags">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className="weq-profile-interest"
              onClick={() => open(item.labelId)}
            >
              {item.text}
            </button>
          ))}
        </div>
      </ContactRow>
      {query.error ? (
        <ContactInlineError
          message="标签加载失败，当前显示本地标签。"
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : null}
    </>
  );
}

function MarksRow({ person, onOpen }: { person: ProfilePerson; onOpen: () => void }) {
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
  if (!marks.length) return null;
  return (
    <ContactRow label="互动标识">
      <div className="weq-profile-tags">
        {marks.map((mark) => (
          <button
            type="button"
            className="weq-contact-value"
            key={`${mark.id}:${mark.text}`}
            onClick={onOpen}
          >
            {mark.icon ? (
              <img width={18} height={18} src={collectionImageUrl(mark.icon)} alt="" />
            ) : null}
            {mark.text}
          </button>
        ))}
      </div>
    </ContactRow>
  );
}

function BotDescription({ person }: { person: ProfilePerson }) {
  const session = useQQWriteSession(`contact-bot:${person.id}`, true);
  const query = useQuery({
    queryKey: ['contact-bot', session.binding, person.uid || person.id],
    queryFn: () =>
      client.account.getBotProfile.query({ uid: person.uid || person.id, ...session.binding }),
    enabled: Boolean(session.binding),
    ...PROFILE_QUERY_OPTIONS,
  });
  const description = query.data?.description;
  return description ? <p className="weq-contact-description">{description}</p> : null;
}

function BotFeaturesRow({ person }: { person: ProfilePerson }) {
  const session = useQQWriteSession(`contact-bot:${person.id}`, true);
  const query = useQuery({
    queryKey: ['contact-bot', session.binding, person.uid || person.id],
    queryFn: () =>
      client.account.getBotProfile.query({ uid: person.uid || person.id, ...session.binding }),
    enabled: Boolean(session.binding),
    ...PROFILE_QUERY_OPTIONS,
  });
  const data = query.data;
  if (!data?.wakeCommand && !data?.welcome && !(data?.commands.length ?? 0)) return null;
  return (
    <>
      <ContactRow label="唤醒指令" value={data?.wakeCommand} mono />
      <ContactRow label="欢迎语" value={data?.welcome} />
      {data?.commands.length ? (
        <ContactRow label="机器人命令">
          <details className="weq-contact-command-list">
            <summary>共 {data.commands.length} 条</summary>
            {data.commands.map((command) => (
              <p key={command.id}>
                <code>{command.command}</code> {command.description}
              </p>
            ))}
          </details>
        </ContactRow>
      ) : null}
    </>
  );
}

function SignatureRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <ContactRow label="个性签名">
      <div className={`weq-contact-signature${open ? ' is-open' : ''}`}>
        <p>{text}</p>
        <button type="button" onClick={() => setOpen(!open)}>
          {open ? '收起' : '展开'}
          <ChevronDown size={12} className={open ? 'is-open' : undefined} />
        </button>
      </div>
    </ContactRow>
  );
}

function memberDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 2000
    ? date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    : null;
}

/** 群内资料：名片里是独立分区，资料页里沿用章节自己的标题。 */
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
  const groupLevel = member.memberLevel
    ? `Lv.${member.memberLevel}${member.levelName ? ` · ${member.levelName}` : ''}`
    : member.levelName;
  const optional: Partial<Record<(typeof settings.groupOrder)[number], ReactNode>> = {
    groupLevel,
    joinedAt: memberDate(member.joinedAt),
    lastSpeakAt: memberDate(member.lastSpeakAt),
  };
  const rows = settings.groupOrder
    .filter((key) => full || settings.visible[key])
    .map((key) => (
      <ContactRow
        key={key}
        label={{ groupLevel: '群等级', joinedAt: '入群时间', lastSpeakAt: '最后群发言' }[key]}
        value={optional[key]}
      />
    ));
  const body = (
    <>
      {relationship === 'nonmember' || member.leftGroup ? (
        <>
          <ContactRow label="群昵称" value={member.card} />
          <ContactRow label="专属头衔" value={member.customTitle} />
        </>
      ) : (
        <QQGroupMemberControls
          groupCode={context.groupCode}
          uid={person.uid || person.id}
          profile={{ card: member.card, title: member.customTitle ?? undefined }}
        />
      )}
      <ContactRow
        label="群角色"
        value={member.role ? { owner: '群主', admin: '管理员', member: '成员' }[member.role] : null}
      />
      {member.leftGroup ? <ContactEmptyState>已退出这个群</ContactEmptyState> : null}
      {muted ? (
        <ContactRow
          label="禁言截止"
          value={new Date(member.muteUntil!).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
          })}
        />
      ) : null}
      {rows}
    </>
  );
  if (full) return <>{body}</>;
  return (
    <ContactSection
      title="群内资料"
      action={
        context.groupName ? (
          <span className="weq-profile-section-note">{context.groupName}</span>
        ) : null
      }
    >
      {body}
    </ContactSection>
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
  trailing,
  preview = false,
}: {
  person: ProfilePerson;
  settings: ContactCardSettings;
  full?: boolean;
  fields?: ContactCardContent[];
  onSection?: (section: ContactWorkspaceTab, labelId?: string) => void;
  onNavigate?: () => void;
  localOnly?: boolean;
  /** 名片宿主可以把「群内资料」等分区插在正文与「更多资料」之间，保持分区顺序一致。 */
  trailing?: ReactNode;
  /** 设置页预览：只渲染内容，不提供跳转与「更多资料」。 */
  preview?: boolean;
}) {
  const [detail, setDetail] = useState<{ view: ProfileExtraView; labelId?: string } | null>(null);
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const navigate = useContext(ContactWorkspaceNavigationContext);
  const friendDirectory = useContext(FriendDirectoryContext);
  const relationship = usePersonRelationship(person);
  const enabled = (key: ContactCardContent) =>
    (!fields || fields.includes(key)) && (full || settings.visible[key]);
  const ext = person.extInfo;
  const birth = contactBirth(person);
  const hasQQ =
    ['QQ', 'UIN'].includes(person.identityLabel) && /^[1-9]\d{4,19}$/.test(person.identityValue);
  const personal = !person.clone && person.kind !== 'bot' && !ext?.isEnterprise && hasQQ;
  const relationIds = [
    ...new Set([person.extRelation?.displayId, ...(person.extRelation?.preselectedIds ?? [])]),
  ].filter((id): id is number => id !== undefined);
  const privileges = (ext?.privileges ?? []).filter((item) => item.opened && item.iconUrl);
  // 资料页由宿主承载章节与目录，名片才需要「更多资料」入口。
  const showMore = !onSection && !preview;
  const technical = full;
  function open(view: ProfileExtraView, labelId?: string) {
    if (preview) return;
    if (onSection) onSection(view === 'education' ? 'details' : view, labelId);
    else setDetail({ view, labelId });
  }
  const rows: Partial<Record<ContactCardContent, ReactNode>> = {
    qqShow: hasQQ && !person.clone && person.kind !== 'bot' ? <QqShowRow person={person} /> : null,
    signature: person.signature ? <SignatureRow text={person.signature} /> : null,
    signatureUpdated: (
      <ContactRow
        label="签名更新"
        value={profileTimeText(person.sigUpdateTime)}
        valueClassName="weq-contact-signature-time"
      />
    ),
    gender: (
      <ContactRow
        label="性别"
        value={person.gender === 1 ? '男' : person.gender === 2 ? '女' : null}
      />
    ),
    age: <ContactRow label="年龄" value={birth.age ? `${birth.age} 岁` : null} />,
    birthday: <ContactBirthdayRow birth={birth} />,
    constellation: <ContactRow label="星座" value={birth.constellation?.name} />,
    zodiac: <ContactRow label="生肖" value={chineseZodiacText(ext?.zodiac)} />,
    bloodType: <ContactRow label="血型" value={bloodTypeText(ext?.bloodType)} />,
    occupation: <ContactRow label="职业" value={occupationText(ext?.occupation)} />,
    region: (
      <ContactRow
        label="所在地"
        value={[...new Set([ext?.country, ext?.province, ext?.city].filter(Boolean))].join(' · ')}
      />
    ),
    school: (
      <ContactRow
        label="学校"
        value={[ext?.school, ext?.degree].filter(Boolean).join(' · ')}
        onActivate={() => open('education')}
        activateTitle="查看教育经历"
      />
    ),
    labels: personal ? <LabelsRow person={person} open={(id) => open('labels', id)} /> : null,
    photos: ext?.album.length ? (
      <ContactRow label="精选照片">
        <div className="weq-profile-album">
          {ext.album.map((photo, index) => {
            const url = photo.urls.find((item) => item.url)?.url;
            return url ? (
              <button
                type="button"
                key={photo.photoId ?? index}
                className="weq-profile-photo"
                title="查看精选图片"
                aria-label="查看精选图片"
                onClick={() => openLightbox(albumMediaUrl(url), '精选图片')}
              >
                <img src={albumMediaUrl(url)} alt="精选图片" loading="lazy" />
              </button>
            ) : null;
          })}
        </div>
      </ContactRow>
    ) : null,
    status: <ContactRow label="当前状态" value={person.customStatus || person.onlineStatus} />,
    common:
      personal && relationship !== 'self' ? (
        <CommonRelationships uin={person.identityValue} onNavigate={onNavigate} />
      ) : null,
    category: (
      <ContactRow
        label="好友分组"
        value={person.categoryName}
        onActivate={
          relationship === 'friend' && friendDirectory?.available
            ? () => friendDirectory.move([person.uid || person.id])
            : undefined
        }
        activateTitle="移动好友分组"
      />
    ),
    intimacy: <ContactRow label="QQ 亲密度" value={person.intimacy || null} />,
    relations: relationIds.length ? (
      <ContactRow label="关系标签">
        <div className="weq-profile-tags">
          {relationIds.map((id) => (
            <span className="weq-profile-tag" key={id}>
              {relationMeta(id).label}
            </span>
          ))}
        </div>
      </ContactRow>
    ) : null,
    marks:
      personal && relationship === 'friend' ? (
        <MarksRow
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
    privileges: privileges.length ? (
      <ContactRow label="已开通特权">
        <div className="weq-profile-privileges">
          {privileges.map((item) => (
            <img
              key={`${item.bizId}:${item.iconUrl}:${item.level}`}
              src={collectionImageUrl(item.iconUrl!)}
              alt={`特权 ${item.bizId ?? ''}`}
              title={`特权 ${item.bizId ?? ''}${item.level ? ` · ${item.level} 级` : ''}`}
              loading="lazy"
            />
          ))}
        </div>
      </ContactRow>
    ) : null,
    level:
      hasQQ && !person.clone && person.kind !== 'bot' ? (
        <ContactStats person={person} field="level" />
      ) : null,
    likes: personal ? <ContactStats person={person} field="likeCount" /> : null,
    energy: personal ? <EnergyRow person={person} /> : null,
    qid: (
      <ContactRow
        label="QID"
        value={person.qid}
        mono
        onActivate={() => person.qid && void copyTextToClipboard(person.qid)}
        activateTitle="复制 QID"
      />
    ),
    uid: (
      <ContactRow
        label="NT UID"
        value={/^u_/.test(person.uid || person.id) ? person.uid || person.id : null}
        mono
        onActivate={() => void copyTextToClipboard(person.uid || person.id)}
        activateTitle="复制 UID"
      />
    ),
    friendClue:
      personal && relationship === 'friend' ? <FriendClue uid={person.uid || person.id} /> : null,
    notes:
      personal && relationship === 'friend' ? (
        <NotesRow person={person} onEdit={() => setRemarkOpen(true)} />
      ) : null,
    company: personal ? (
      <ExtraField person={person} field="company" onOpen={() => open('details')} />
    ) : null,
    description: personal ? (
      <ExtraField person={person} field="description" onOpen={() => open('details')} />
    ) : null,
    email: personal ? (
      <ExtraField person={person} field="email" onOpen={() => open('details')} />
    ) : null,
    botDescription: person.kind === 'bot' ? <BotDescription person={person} /> : null,
    botFeatures: person.kind === 'bot' ? <BotFeaturesRow person={person} /> : null,
  };
  const ordered = settings.order.filter(
    (key) => enabled(key) && (!localOnly || !automaticFields.includes(key)),
  );
  // 名片正文：「其他与机器人」把 QID / NT UID 这类可选展示项也收进来（清单 A39/A40 要求它们是正文可选项）；
  // 资料页则把它们固定放进「技术详情」，与开关无关。
  const buckets = {
    basic: ordered.filter((key) => contactCardFieldGroup(key) === 'basic'),
    social: ordered.filter((key) => contactCardFieldGroup(key) === 'social'),
    bot: full
      ? ordered.filter((key) => contactCardFieldGroup(key) === 'bot')
      : ordered.filter((key) => ['bot', 'tech'].includes(contactCardFieldGroup(key))),
    tech: full ? ordered.filter((key) => contactCardFieldGroup(key) === 'tech') : [],
  };
  const blocks: Array<{ key: keyof typeof buckets; title: string; rows: ReactNode[] }> = [
    { key: 'basic', title: '基本信息', rows: [] },
    { key: 'social', title: '互动与关系', rows: [] },
    { key: 'bot', title: '其他与机器人', rows: [] },
    { key: 'tech', title: '技术详情', rows: [] },
  ];
  for (const block of blocks)
    block.rows = buckets[block.key]
      .map((key) => {
        const node = rows[key];
        return node ? (
          <div className="weq-profile-row-slot" key={key} data-profile-field={key}>
            {node}
          </div>
        ) : null;
      })
      .filter(Boolean) as ReactNode[];
  const techBlockRaw = blocks.find((block) => block.key === 'tech');
  if (!technical && techBlockRaw) techBlockRaw.rows = [];
  // 资料页技术详情：QID / NT UID 始终在，不受名片开关影响。
  const techRows = technical
    ? (
        [
          ['qid', rows.qid],
          ['uid', rows.uid],
        ] as const
      )
        .filter(([, node]) => Boolean(node))
        .map(([key, node]) => <Fragment key={key}>{node}</Fragment>)
    : [];
  const visibleBlocks = blocks.filter((block) => block.rows.length > 0);
  const techBlock = visibleBlocks.find((block) => block.key === 'tech');
  const titled = visibleBlocks.filter((block) => block.key !== 'tech');
  const sectioned = titled.length > 1;
  return (
    <>
      {!visibleBlocks.length ? (
        <ContactEmptyState>
          {person.clone ? '这个本地会话还没有可显示的资料。' : '没有可显示的公开资料。'}
        </ContactEmptyState>
      ) : null}
      {titled.length ? (
        <div className="weq-profile-data">
          {titled.map((block) =>
            sectioned ? (
              <ContactSection key={block.key} title={block.title}>
                {block.rows}
              </ContactSection>
            ) : (
              <ContactSection key={block.key} title={block.title} hideTitle>
                {block.rows}
              </ContactSection>
            ),
          )}
          {techRows.length ? (
            <ContactTechnicalDetails>{techRows}</ContactTechnicalDetails>
          ) : techBlock ? (
            <ContactTechnicalDetails>{techBlock.rows}</ContactTechnicalDetails>
          ) : null}
        </div>
      ) : null}
      {trailing}
      {personal && showMore ? (
        <nav className="weq-contact-more" aria-label="更多资料">
          <details>
            <summary>更多资料</summary>
            <div className="weq-contact-more-links">
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
                  navigate?.({
                    kind: 'person',
                    contact: { createdAt: '', ...person } as Contact,
                    tab: 'history',
                  })
                }
              >
                资料历史
              </button>
            </div>
          </details>
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
