import { useEffect, useId, useState } from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ChevronRight,
  GraduationCap,
  History,
  Images,
  MessageCircleQuestion,
  RotateCcw,
  X,
  Zap,
} from 'lucide-react';
import type { PersonalityLabel, PersonalityPhoto } from '@weq/protocol';
import { Modal } from './Dialog';
import { SegmentedControl } from './SegmentedControl';
import { ProfileDetailsEntry, ProfileDetailsContent } from './ProfileDetailsEntry';
import { ProfileDisplayEntry } from './ProfileDisplaySettings';
import {
  SignatureInteractions,
  QuestionInteractions,
  ProfileLikeSummary,
  PersonalityPhotoUploader,
} from './ProfileInteractions';
import { QzoneMediaPreview } from './QzoneMediaPreview';
import { useQQWriteSession, type QQWriteBinding } from '../hooks/useQQWriteSession';
import { useTabActive } from './RetainedTabs';
import { trpc } from '../trpc/client';
import { albumMediaUrl } from '../lib/resourceUrl';
import { extrasPageWarning, mergeExtrasPages, nextExtrasCursor } from '../lib/profileExtrasPages';
import { educationDegree, educationRows, educationYears } from '../lib/profileEducation';
import '../styles/profile-extras.css';

type Target = QQWriteBinding & { uin: string };
type View = 'signatures' | 'labels' | 'questions' | 'education';
export type ProfileExtraView = View | 'details';
export function ProfileExtrasContent({
  uin,
  view,
  labelId,
}: {
  uin: string;
  view: ProfileExtraView;
  labelId?: string;
}) {
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
      ) : view === 'labels' ? (
        <Labels input={input} online={session.available} labelId={labelId} />
      ) : (
        <Questions input={input} online={session.available} />
      )}
    </div>
  );
}
export function ProfileExtraDialog({
  uin,
  view,
  labelId,
  onClose,
}: {
  uin: string;
  view: ProfileExtraView;
  labelId?: string;
  onClose: () => void;
}) {
  const id = useId();
  const title = {
    details: '详细资料',
    education: '教育经历',
    signatures: '历史个性签名',
    labels: '标签相册',
    questions: '匿问我答',
  }[view];
  return (
    <Modal onClose={onClose} labelledBy={id} width={680} className="weq-extras-dialog">
      <header className="weq-extras-header">
        <h2 id={id}>{title}</h2>
        <button type="button" title="关闭" aria-label="关闭资料详情" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <ProfileExtrasContent uin={uin} view={view} labelId={labelId} />
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
const date = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
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
  const [view, setView] = useState<View | null>(null);
  const energy = trpc.account.profileExtras.energy.useQuery(input, {
    ...queryOptions,
    enabled: online && section === 'details',
  });
  const usable = energy.data?.targetUin === input.uin ? energy.data : null;
  const titleId = useId();
  const title =
    view === 'signatures'
      ? '历史个性签名'
      : view === 'labels'
        ? '标签相册'
        : view === 'education'
          ? '教育经历'
          : '匿问我答';
  return (
    <>
      {section === 'signature' ? (
        <button
          className="weq-extras-history"
          type="button"
          title="查看历史个性签名"
          onClick={() => setView('signatures')}
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
                ? (usable.score ?? '未知')
                : !online
                  ? '暂不可读取'
                  : energy.isFetching
                    ? '读取中'
                    : energy.error
                      ? '暂不可读取'
                      : '未知'}
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
            <ProfileDisplayEntry field="education">
              <button type="button" title="查看完整教育经历" onClick={() => setView('education')}>
                <GraduationCap size={15} />
                教育经历
                <ChevronRight size={14} />
              </button>
            </ProfileDisplayEntry>
            <ProfileDisplayEntry field="personalityLabels">
              <button type="button" onClick={() => setView('labels')}>
                <Images size={15} />
                标签相册
                <ChevronRight size={14} />
              </button>
            </ProfileDisplayEntry>
            <ProfileDisplayEntry field="anonymousQuestions">
              <button type="button" onClick={() => setView('questions')}>
                <MessageCircleQuestion size={15} />
                匿问我答
                <ChevronRight size={14} />
              </button>
            </ProfileDisplayEntry>
          </div>
        </section>
      )}
      {view ? (
        <Modal
          onClose={() => setView(null)}
          labelledBy={titleId}
          width={680}
          className="weq-extras-dialog"
        >
          <header className="weq-extras-header">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              aria-label="关闭资料详情"
              title="关闭"
              onClick={() => setView(null)}
            >
              <X size={18} />
            </button>
          </header>
          <div className="weq-extras-content" data-privacy-sensitive>
            {view === 'education' ? (
              <EducationHistory input={input} online={online} />
            ) : view === 'signatures' ? (
              <Signatures input={input} online={online} />
            ) : view === 'labels' ? (
              <Labels input={input} online={online} />
            ) : (
              <Questions input={input} online={online} />
            )}
          </div>
        </Modal>
      ) : null}
    </>
  );
}
function EducationHistory({ input, online }: { input: Target; online: boolean }) {
  const active = useTabActive();
  const query = trpc.account.profileExtras.educationHistory.useQuery(input, {
    ...queryOptions,
    enabled: online && active,
  });
  const usable = query.data?.targetUin === input.uin ? query.data : null;
  const rows = educationRows(usable?.items ?? [], input.uin === input.expectedAccountUin);
  const error = query.error || (query.data && !usable ? new Error('教育经历返回目标不匹配') : null);
  return (
    <>
      <PageStatus
        online={online}
        pending={query.isFetching}
        error={error}
        empty={!rows.length}
        emptyText="暂无可展示的教育经历"
        retry={() => void query.refetch()}
      />
      {rows.length ? (
        <div className="weq-education-refresh">
          {error ? <span role="status">读取失败，已显示的教育经历保留。</span> : null}
          <button
            type="button"
            className="weq-extras-back"
            disabled={!online || query.isFetching}
            onClick={() => void query.refetch()}
            aria-label="重新读取教育经历"
          >
            <RotateCcw size={14} />
            {query.isFetching ? '读取中…' : '刷新'}
          </button>
        </div>
      ) : null}
      <div className="weq-extras-list weq-education-list">
        {rows.map(({ key, record }) => (
          <article key={key}>
            <h3>{record.schoolName?.trim() || '未填写学校'}</h3>
            {record.departmentName ? <p>{record.departmentName}</p> : null}
            {educationDegree(record.degree) ? <p>{educationDegree(record.degree)}</p> : null}
            {educationYears(record) ? <p>{educationYears(record)}</p> : null}
            <div className="weq-extras-counts">
              {record.verifyStatus === 2 ? <span>已认证</span> : null}
              {record.hidden === 1 ? <span>未公开</span> : null}
            </div>
          </article>
        ))}
      </div>
    </>
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
          <button type="button" disabled={!online} onClick={retry}>
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
        <button type="button" disabled={!online || loading} onClick={load}>
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
function Labels({ input, online, labelId }: { input: Target; online: boolean; labelId?: string }) {
  const active = useTabActive();
  const [selected, setSelected] = useState<PersonalityLabel | null>(null);
  const [photoRevision, setPhotoRevision] = useState(0);
  const query = trpc.account.profileExtras.personalityLabels.useQuery(input, {
    ...queryOptions,
    enabled: online && active,
  });
  useEffect(() => {
    if (labelId)
      setSelected((previous) =>
        previous?.id === labelId
          ? previous
          : (query.data?.labels.find((label) => label.id === labelId) ?? null),
      );
  }, [labelId, query.data]);
  if (selected)
    return (
      <>
        <button type="button" className="weq-extras-back" onClick={() => setSelected(null)}>
          <ArrowLeft size={14} />
          全部标签
        </button>
        <h3 className="weq-extras-label-title">{selected.text}</h3>
        <ProfileLikeSummary users={selected.likeUsers ?? []} total={selected.likes} />
        {input.uin === input.expectedAccountUin ? (
          <PersonalityPhotoUploader
            input={input}
            label={selected}
            online={online}
            refresh={async () => {
              const result = await query.refetch();
              const fresh = result.data?.labels.find((label) => label.id === selected.id);
              if (fresh) setSelected(fresh);
              setPhotoRevision((value) => value + 1);
            }}
          />
        ) : null}
        <Photos
          key={`${selected.id}:${photoRevision}`}
          input={input}
          online={online}
          label={selected}
        />
      </>
    );
  return (
    <>
      <PageStatus
        online={online}
        pending={query.isFetching}
        error={query.error}
        empty={!query.data?.labels.length}
        emptyText={query.data?.closed ? '标签相册未公开' : '暂无标签相册'}
        retry={() => void query.refetch()}
      />
      <div className="weq-extras-labels">
        {query.data?.labels.map((label) => (
          <button type="button" key={label.id} onClick={() => setSelected(label)}>
            {label.cover ? (
              <ProfilePhoto src={label.cover} alt="" />
            ) : (
              <span className="weq-extras-label-placeholder">
                <Images size={24} />
              </span>
            )}
            <span>{label.text || '未命名标签'}</span>
            <small>{label.photoCount === null ? '' : `${label.photoCount} 张`}</small>
          </button>
        ))}
      </div>
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
        <QzoneMediaPreview
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
