import { eventTimeFormatter } from '@weq/time';
import { useId, useRef, useState } from 'react';
import {
  ArrowDown,
  ChevronRight,
  GraduationCap,
  History,
  MessageCircleQuestion,
  RotateCcw,
  X,
  Zap,
} from 'lucide-react';
import type { PersonalityLabel, PersonalityPhoto } from '@weq/protocol';
import { Modal } from './Dialog';
import { OverlayLayer } from './OverlayLayer';
import { SegmentedControl } from './SegmentedControl';
import { ProfileDetailsEntry, ProfileDetailsContent } from './ProfileDetailsEntry';
import { ProfileDisplayEntry, ProfileDisplaySettingField } from './ProfileDisplaySettings';
import { useSelfProfileFields } from './SelfProfileFields';
import { SelfSignatureComposer } from './SelfSignatureComposer';
import {
  SignatureInteractions,
  QuestionInteractions,
  ProfileLabelLikes,
  PersonalityPhotoUploader,
} from './ProfileInteractions';
import { MediaPreview } from './MediaPreview';
import { useQQWriteSession, type QQWriteBinding } from '../hooks/useQQWriteSession';
import { ContactInlineError, ContactRow, ContactSection } from './contactProfile/ContactRow';
import { useTabActive } from './RetainedTabs';
import { trpc } from '../trpc/client';
import { albumMediaUrl } from '../lib/resourceUrl';
import { extrasPageWarning, mergeExtrasPages, nextExtrasCursor } from '../lib/profileExtrasPages';
import { educationDegree, educationRows, educationYears } from '../lib/profileEducation';
import '../styles/profile-extras.css';

type Target = QQWriteBinding & { uin: string };
type View = 'signatures' | 'questions' | 'education';
export type ProfileExtraView = View | 'details';
export function ProfileExtrasContent({ uin, view }: { uin: string; view: ProfileExtraView }) {
  const session = useQQWriteSession(`profile-extras:${uin}`);
  const input = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    uin,
  };
  const key = `${input.expectedAccountUin}:${input.expectedAccountConfigId}:${uin}:${view}`;
  return (
    <div key={key} className="weq-extras-content" data-privacy-sensitive>
      {view === 'details' ? (
        <ProfileDetailsContent input={input} online={session.available} />
      ) : view === 'education' ? (
        <EducationHistory input={input} online={session.available} />
      ) : view === 'signatures' ? (
        <Signatures input={input} online={session.available} />
      ) : (
        <Questions input={input} online={session.available} />
      )}
    </div>
  );
}
export function ProfileExtraDialog({
  uin,
  view,
  onClose,
  anchor,
}: {
  uin: string;
  view: ProfileExtraView;
  onClose: () => void;
  anchor?: HTMLElement | null;
}) {
  const self = useSelfProfileFields();
  const id = useId();
  const title = {
    details: '详细资料',
    education: '教育经历',
    signatures: '个性签名',
    questions: '匿问我答',
  }[view];
  return (
    <Modal
      onClose={onClose}
      labelledBy={id}
      width={view === 'signatures' ? 520 : 680}
      className={`weq-extras-dialog${view === 'signatures' ? ' weq-signature-history-dialog' : ''}`}
      presentation={view === 'signatures' || view === 'education' ? 'popover' : 'modal'}
      anchor={anchor}
      anchorPlacement="side"
    >
      <header className="weq-extras-header">
        <h2 id={id}>{title}</h2>
        <button type="button" title="关闭" aria-label="关闭资料详情" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      {view === 'signatures' ? <SelfSignatureComposer uin={uin} /> : null}
      {view === 'education' && self?.uin === uin ? (
        <div className="weq-extras-range-row">
          <ProfileDisplaySettingField field="education" />
        </div>
      ) : null}
      <ProfileExtrasContent uin={uin} view={view} />
    </Modal>
  );
}
const queryOptions = {
  staleTime: 5 * 60_000,
  cacheTime: 5 * 60_000,
  retry: false as const,
  refetchOnWindowFocus: false,
  refetchOnMount: true,
};
const date = eventTimeFormatter;
function time(value: number | null) {
  return value === null ? '' : date.format(value * 1000);
}

export function ProfileExtras({
  uin,
  section = 'details',
}: {
  uin: string;
  section?: 'signature' | 'details';
}) {
  const session = useQQWriteSession(`profile-extras:${uin}`);
  if (!/^[1-9]\d{0,19}$/.test(uin)) return null;
  const input = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    uin,
  };
  return (
    <ExtrasBody
      key={`${input.expectedAccountUin}:${input.expectedAccountConfigId}:${uin}:${section}`}
      input={input}
      online={session.available}
      section={section}
    />
  );
}
function ExtrasBody({
  input,
  online,
  section,
}: {
  input: Target;
  online: boolean;
  section: 'signature' | 'details';
}) {
  const [detail, setDetail] = useState<{ view: View; anchor?: HTMLElement } | null>(null);
  const energy = trpc.account.profileExtras.energy.useQuery(input, {
    ...queryOptions,
    enabled: online && section === 'details',
  });
  const usable = energy.data?.targetUin === input.uin ? energy.data : null;
  return (
    <>
      {section === 'signature' ? (
        <button
          className="weq-extras-history"
          type="button"
          title="查看个性签名"
          aria-haspopup="dialog"
          aria-expanded={detail?.view === 'signatures'}
          onClick={({ currentTarget: anchor }) =>
            setDetail((value) =>
              value?.view === 'signatures' ? null : { view: 'signatures', anchor },
            )
          }
        >
          <History size={13} />
          历史签名
        </button>
      ) : (
        <section className="weq-extras-summary" aria-label="个人资料扩展">
          <div className="weq-extras-energy">
            <span>
              <Zap size={13} />
              QQ 能量值
            </span>
            <strong aria-live="polite">
              {usable
                ? (usable.score ?? '未记录')
                : !online
                  ? '暂不可读取'
                  : energy.isFetching
                    ? '读取中'
                    : energy.error
                      ? '暂不可读取'
                      : '未读取'}
            </strong>
            {energy.error && online ? (
              <button
                type="button"
                title="重试读取能量值"
                aria-label="重试读取能量值"
                onClick={() => void energy.refetch()}
              >
                <RotateCcw size={13} />
              </button>
            ) : null}
          </div>
          <div className="weq-extras-links">
            <ProfileDetailsEntry input={input} online={online} />
            <ProfileDisplayEntry field="education" unframed>
              <button
                type="button"
                title="查看完整教育经历"
                onClick={() => setDetail({ view: 'education' })}
              >
                <GraduationCap size={15} />
                教育经历
                <ChevronRight size={14} />
              </button>
            </ProfileDisplayEntry>
            <ProfileDisplayEntry field="anonymousQuestions" unframed>
              <button type="button" onClick={() => setDetail({ view: 'questions' })}>
                <MessageCircleQuestion size={15} />
                匿问我答
                <ChevronRight size={14} />
              </button>
            </ProfileDisplayEntry>
          </div>
        </section>
      )}
      {detail ? (
        <ProfileExtraDialog
          uin={input.uin}
          view={detail.view}
          anchor={detail.anchor}
          onClose={() => setDetail(null)}
        />
      ) : null}
    </>
  );
}
type EducationQuery = {
  rows: ReturnType<typeof educationRows>;
  error: unknown;
  fetching: boolean;
  refetch: () => unknown;
};

/** 教育经历同样走唯一行模型：一段经历一组数据行，前端不再自建卡片或浮动刷新条。 */
function useEducation(input: Target, online: boolean): EducationQuery {
  const active = useTabActive();
  const query = trpc.account.profileExtras.educationHistory.useQuery(input, {
    ...queryOptions,
    enabled: online && active,
  });
  const usable = query.data?.targetUin === input.uin ? query.data : null;
  return {
    rows: educationRows(usable?.items ?? [], input.uin === input.expectedAccountUin),
    error: query.error || (query.data && !usable ? new Error('教育经历返回目标不匹配') : null),
    fetching: query.isFetching,
    refetch: query.refetch,
  };
}

function EducationRows({ rows }: { rows: ReturnType<typeof educationRows> }) {
  return (
    <div className="weq-profile-data">
      {rows.map(({ key, record }) => (
        <div className="weq-education-record" key={key}>
          <ContactRow label="学校" value={record.schoolName?.trim() || '未填写学校'} />
          <ContactRow label="院系" value={record.departmentName} />
          <ContactRow label="学历" value={educationDegree(record.degree)} />
          <ContactRow label="时间" value={educationYears(record)} />
          <ContactRow
            label="状态"
            value={
              [record.verifyStatus === 2 ? '已认证' : '', record.hidden === 1 ? '未公开' : '']
                .filter(Boolean)
                .join(' · ') || null
            }
          />
        </div>
      ))}
    </div>
  );
}

function EducationHistory({ input, online }: { input: Target; online: boolean }) {
  const education = useEducation(input, online);
  return (
    <>
      <PageStatus
        online={online}
        pending={education.fetching}
        error={education.error}
        empty={!education.rows.length}
        emptyText="暂无可展示的教育经历"
        retry={() => void education.refetch()}
      />
      {education.rows.length ? <EducationRows rows={education.rows} /> : null}
      {education.rows.length && education.error ? (
        <ContactInlineError
          message="刷新失败，已显示的教育经历保留。"
          onRetry={() => void education.refetch()}
          retrying={education.fetching}
        />
      ) : null}
    </>
  );
}

/** 资料页「教育经历」分区：无内容且无错误时不占位，有内容时标题右侧提供刷新。 */
export function EducationSection({ uin }: { uin: string }) {
  const session = useQQWriteSession(`profile-extras:${uin}`);
  const input = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    uin,
  };
  const education = useEducation(input, session.available);
  if (!education.rows.length && !education.error) return null;
  return (
    <ContactSection
      title="教育经历"
      action={
        education.rows.length ? (
          <button
            type="button"
            className="weq-profile-section-action"
            title="重新读取教育经历"
            disabled={!session.available || education.fetching}
            onClick={() => void education.refetch()}
          >
            <RotateCcw size={12} />
            {education.fetching ? '读取中…' : '刷新'}
          </button>
        ) : undefined
      }
    >
      {education.rows.length ? <EducationRows rows={education.rows} /> : null}
      {education.error ? (
        <ContactInlineError
          message={education.rows.length ? '刷新失败，已显示的教育经历保留。' : '教育经历读取失败'}
          onRetry={() => void education.refetch()}
          retrying={education.fetching}
        />
      ) : null}
    </ContactSection>
  );
}
function PageStatus({
  online,
  pending,
  error,
  empty,
  emptyText,
  retry,
}: {
  online: boolean;
  pending: boolean;
  error: unknown;
  empty: boolean;
  emptyText: string;
  retry: () => void;
}) {
  if (!empty) return null;
  return (
    <div className="weq-extras-status" role="status">
      {pending ? (
        '读取中…'
      ) : error ? (
        <>
          <span>读取失败</span>
          <button
            className="weq-set-btn weq-set-btn-soft"
            type="button"
            disabled={!online}
            onClick={retry}
          >
            <RotateCcw size={14} />
            重试
          </button>
        </>
      ) : !online ? (
        '暂不可在线读取'
      ) : (
        emptyText
      )}
    </div>
  );
}
function More({
  online,
  loading,
  error,
  hasMore,
  warning,
  load,
}: {
  online: boolean;
  loading: boolean;
  error: unknown;
  hasMore: boolean;
  warning: string | null;
  load: () => void;
}) {
  return (
    <footer className="weq-extras-more">
      {warning ? (
        <p role="status">{warning}</p>
      ) : error ? (
        <p role="status">本页读取失败，已加载内容保留。</p>
      ) : null}
      {hasMore || error || warning || loading ? (
        <button
          className="weq-set-btn weq-set-btn-soft"
          type="button"
          disabled={!online || loading}
          onClick={load}
        >
          {error || warning ? <RotateCcw size={14} /> : <ArrowDown size={14} />}
          {loading ? '读取中…' : error || warning ? '重试本页' : '加载更多'}
        </button>
      ) : null}
    </footer>
  );
}
function Signatures({ input, online }: { input: Target; online: boolean }) {
  const active = useTabActive();
  const query = trpc.account.profileExtras.signatureHistory.useInfiniteQuery(input, {
    ...queryOptions,
    enabled: online && active,
    getNextPageParam: nextExtrasCursor,
  });
  const pages = query.data?.pages ?? [];
  const items = mergeExtrasPages(pages);
  const warning = extrasPageWarning(pages);
  return (
    <>
      <PageStatus
        online={online}
        pending={query.isFetching}
        error={query.error}
        empty={!items.length}
        emptyText="暂无历史签名"
        retry={() => void query.refetch()}
      />
      <div className="weq-extras-list">
        {items.map((item) => (
          <article key={item.id}>
            <time>{time(item.createdAt)}</time>
            <p>{[item.action, item.data, item.text].filter(Boolean).join(' ') || '空签名'}</p>
            {item.location ? <small>{item.location}</small> : null}
            <SignatureInteractions
              input={input}
              item={item}
              online={online}
              refresh={() =>
                query.refetch({
                  refetchPage: (_page, index) =>
                    pages[index]?.items.some((row) => row.id === item.id) ?? false,
                })
              }
            />
          </article>
        ))}
      </div>
      {pages.length ? (
        <More
          online={online}
          loading={query.isFetching}
          error={query.error}
          hasMore={Boolean(query.hasNextPage)}
          warning={warning}
          load={() =>
            void (warning
              ? query.refetch({ refetchPage: (_page, index, pages) => index === pages.length - 1 })
              : query.fetchNextPage())
          }
        />
      ) : null}
    </>
  );
}
function Questions({ input, online }: { input: Target; online: boolean }) {
  const [filter, setFilter] = useState<'all' | 'answered'>(
    input.uin === input.expectedAccountUin ? 'all' : 'answered',
  );
  return (
    <>
      {input.uin === input.expectedAccountUin ? (
        <SegmentedControl
          label="问答显示范围"
          value={filter}
          options={[
            { value: 'all', label: '全部' },
            { value: 'answered', label: '已回答' },
          ]}
          onChange={setFilter}
        />
      ) : null}
      <QuestionList key={filter} input={input} online={online} filter={filter} />
    </>
  );
}
function QuestionList({
  input,
  online,
  filter,
}: {
  input: Target;
  online: boolean;
  filter: 'all' | 'answered';
}) {
  const active = useTabActive();
  const query = trpc.account.profileExtras.anonymousQuestions.useInfiniteQuery(
    { ...input, filter },
    { ...queryOptions, enabled: online && active, getNextPageParam: nextExtrasCursor },
  );
  const pages = query.data?.pages ?? [];
  const items = mergeExtrasPages(pages);
  const warning = extrasPageWarning(pages);
  return (
    <>
      <PageStatus
        online={online}
        pending={query.isFetching}
        error={query.error}
        empty={!items.length}
        emptyText="暂无问答"
        retry={() => void query.refetch()}
      />
      <div className="weq-extras-list">
        {items.map((item) => (
          <article key={item.id}>
            <time>{time(item.askedAt)}</time>
            <h3>{item.question || '未提供问题正文'}</h3>
            {item.answer || (item.answeredAt ?? 0) > 0 ? (
              <>
                <p>{item.answer || '空回答'}</p>
                {item.answeredAt !== null ? <small>回答于 {time(item.answeredAt)}</small> : null}
              </>
            ) : (
              <small>尚未回答</small>
            )}
            <QuestionInteractions input={input} item={item} online={online} />
          </article>
        ))}
      </div>
      {pages.length ? (
        <More
          online={online}
          loading={query.isFetching}
          error={query.error}
          hasMore={Boolean(query.hasNextPage)}
          warning={warning}
          load={() =>
            void (warning
              ? query.refetch({ refetchPage: (_page, index, pages) => index === pages.length - 1 })
              : query.fetchNextPage())
          }
        />
      ) : null}
    </>
  );
}
export function ProfileLabelAlbum({
  input,
  online,
  label,
  refresh,
  disabled = false,
}: {
  input: Target;
  online: boolean;
  label: PersonalityLabel;
  refresh: () => Promise<unknown>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [photoRevision, setPhotoRevision] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  const title = label.text || '未命名标签';
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="weq-profile-interest"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        {title}
      </button>
      {open ? (
        <OverlayLayer presentation="popover" anchor={anchor.current} onClose={() => setOpen(false)}>
          <section
            id={id}
            className="weq-label-album"
            aria-label={`${title}相册`}
            data-privacy-sensitive
          >
            <header className="weq-extras-header">
              <h2>{title}</h2>
              <button
                type="button"
                title="关闭相册"
                aria-label="关闭标签相册"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            <div className="weq-label-album-content">
              {input.uin === input.expectedAccountUin ? (
                <ProfileDisplaySettingField field="personalityLabels" />
              ) : null}
              <ProfileLabelLikes users={label.likeUsers ?? []} total={label.likes} />
              {input.uin === input.expectedAccountUin ? (
                <PersonalityPhotoUploader
                  input={input}
                  label={label}
                  online={online}
                  refresh={async () => {
                    await refresh();
                    setPhotoRevision((value) => value + 1);
                  }}
                />
              ) : null}
              <Photos
                key={`${label.id}:${photoRevision}`}
                input={input}
                online={online}
                label={label}
              />
            </div>
          </section>
        </OverlayLayer>
      ) : null}
    </>
  );
}
function ProfilePhoto({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed || !src ? (
    <span className="weq-extras-photo-error">图片暂不可用</span>
  ) : (
    <img src={albumMediaUrl(src)} alt={alt} loading="lazy" onError={() => setFailed(true)} />
  );
}
function Photos({
  input,
  online,
  label,
}: {
  input: Target;
  online: boolean;
  label: PersonalityLabel;
}) {
  const active = useTabActive();
  const [preview, setPreview] = useState<number | null>(null);
  const complete = label.photoCount !== null && label.photos.length >= label.photoCount;
  const query = trpc.account.profileExtras.personalityPhotos.useInfiniteQuery(
    { ...input, labelId: label.id },
    {
      ...queryOptions,
      initialCursor: label.photoCursor ?? undefined,
      refetchOnMount: 'always',
      enabled: online && active && !complete,
      getNextPageParam: nextExtrasCursor,
    },
  );
  const pages = query.data?.pages ?? [];
  const items: PersonalityPhoto[] = mergeExtrasPages([{ items: label.photos }, ...pages]);
  const warning = extrasPageWarning(pages);
  return (
    <>
      <PageStatus
        online={online}
        pending={query.isFetching}
        error={query.error}
        empty={!items.length}
        emptyText="暂无照片"
        retry={() => void query.refetch()}
      />
      <div className="weq-extras-photos">
        {items.map((item, index) => (
          <button
            type="button"
            key={item.id}
            title={time(item.uploadedAt) || '查看照片'}
            aria-label={`查看第 ${index + 1} 张照片`}
            onClick={() => setPreview(index)}
          >
            <ProfilePhoto src={item.url} alt={`${label.text} ${index + 1}`} />
          </button>
        ))}
      </div>
      {!complete ? (
        <More
          online={online}
          loading={query.isFetching}
          error={query.error}
          hasMore={Boolean(query.hasNextPage)}
          warning={warning}
          load={() =>
            void (warning
              ? query.refetch({ refetchPage: (_page, index, pages) => index === pages.length - 1 })
              : query.data
                ? query.fetchNextPage()
                : query.refetch())
          }
        />
      ) : null}
      {preview !== null ? (
        <MediaPreview
          label="标签照片预览"
          items={items.map((item) => ({
            key: item.id,
            kind: 'image',
            src: albumMediaUrl(item.url),
            title: label.text,
          }))}
          initialIndex={preview}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  );
}
