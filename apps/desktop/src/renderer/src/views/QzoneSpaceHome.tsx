import { useState } from 'react';
import { FileText, Info, Save, Trash2 } from 'lucide-react';
import { client, trpc } from '../trpc/client';
import { projectPublicFeed, type PublicFeedView } from '../lib/qzonePublic';
import { useQQAction } from '../components/qq-actions/shared.shared';
import { EditorDialog } from '../components/EditorDialog';
import { CopyButton } from '../components/CopyButton';
import { NumericText } from '../components/NumericText';
import { QzoneActionsRow } from '../components/QzoneActionsRow';
import { QzonePersonHeader } from '../components/QzoneProfileAvatar';
import { QqArk } from '../components/ark/QqArk';
import { ActionFeedback } from '../components/qq-actions/shared';
import { Row } from '../components/settings/controls';
import { LoadingStatus, QzoneMediaGrid, State } from './qzoneShared';
import { timeText } from './qzoneShared.shared';

const record = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function ordinaryId(feed: PublicFeedView) {
  const common = record(feed.feed.cell_common);
  const union = record(common.union_id);
  const tid = union.feed_id;
  return typeof tid === 'string' && /^[\da-f]{24}$/i.test(tid) && feed.author.uin ? tid : null;
}

function FeedText({ feed }: { feed: PublicFeedView }) {
  const common = record(feed.feed.cell_common);
  const title = typeof common.title === 'string' ? common.title : '';
  return (
    <>
      <p className="weq-qzn-content">{feed.text || title || '动态内容暂不可预览'}</p>
      <QzoneMediaGrid
        images={feed.media.filter((item) => item.kind === 'image').map((item) => item.src)}
        videos={[]}
      />
    </>
  );
}

function OrdinaryDetail({
  hostUin,
  tid,
  selfUin,
  onClose,
  refresh,
}: {
  hostUin: string;
  tid: string;
  selfUin: string;
  onClose: () => void;
  refresh: () => Promise<unknown>;
}) {
  const action = useQQAction(`qzone-ordinary:${hostUin}:${tid}`, 'failure-only');
  const input = { ...action.binding!, hostUin, tid };
  const detail = trpc.account.qqActions.qzoneOrdinaryDetail.useQuery(input, {
    enabled: action.available,
    retry: false,
  });
  const share = trpc.account.qqActions.qzoneOrdinaryShare.useMutation();
  const feed = projectPublicFeed(detail.data?.feed);
  return (
    <EditorDialog title="空间动态" onClose={onClose} busy={action.pending}>
      {detail.isFetching ? <LoadingStatus /> : null}
      {detail.error ? <p role="alert">{detail.error.message}</p> : null}
      {feed ? <FeedText feed={feed} /> : null}
      {detail.data || share.data || share.error ? (
        <section className="weq-qzn-share-result" aria-label="分享卡片">
          {share.data ? <QqArk arkData={share.data.ark} /> : null}
          {share.data?.notice ? <p>{share.data.notice}</p> : null}
          {share.error ? <p role="alert">{share.error.message}</p> : null}
          <div className="weq-qq-action-bar">
            {detail.data ? (
              <button
                type="button"
                className="weq-set-btn"
                disabled={share.isLoading || !action.available}
                onClick={() => share.mutate(input)}
              >
                {share.isLoading ? '正在生成…' : share.data ? '重新生成卡片' : '生成分享卡片'}
              </button>
            ) : null}
            {share.data ? (
              <CopyButton text={share.data.ark} className="weq-set-btn weq-set-btn-primary">
                {share.data.requires_confirmation ? '确认并复制卡片' : '复制卡片'}
              </CopyButton>
            ) : null}
          </div>
        </section>
      ) : null}
      {detail.data && hostUin === selfUin ? (
        <footer className="weq-qzn-post-detail-management">
          <button
            type="button"
            className="weq-set-btn"
            data-danger="outline"
            disabled={action.disabled}
            onClick={() => {
              let confirmed = false;
              void action
                .perform(
                  async (binding) => {
                    const result = await client.account.qqActions.removeQzonePost.mutate({
                      ...binding,
                      hostUin,
                      tid,
                    });
                    confirmed = result.state === 'confirmed';
                    return result;
                  },
                  refresh,
                  '删除这条 QQ 空间说说？',
                  {
                    danger: 'outline',
                    requireReadback: true,
                    readback: async () => confirmed,
                    readbackSuccessText: '说说已删除',
                  },
                )
                .then((done) => {
                  if (done) onClose();
                });
            }}
          >
            <Trash2 size={15} aria-hidden />
            删除说说
          </button>
        </footer>
      ) : null}
      <ActionFeedback action={action} />
    </EditorDialog>
  );
}

function SpaceProfile({
  hostUin,
  selfUin,
  onClose,
}: {
  hostUin: string;
  selfUin: string;
  onClose: () => void;
}) {
  const action = useQQAction(`qzone-space-profile:${hostUin}`, 'failure-only');
  const query = trpc.account.qqActions.qzoneSpaceProfile.useQuery(
    { ...action.binding!, hostUin },
    { enabled: action.available, retry: false },
  );
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  const editable = hostUin === selfUin;
  const profile = draft ?? query.data;
  return (
    <EditorDialog title="空间资料" onClose={onClose} draft={draft} busy={action.pending}>
      {query.isFetching && !query.data ? <LoadingStatus /> : null}
      {query.error ? <p role="alert">{query.error.message}</p> : null}
      {profile && editable ? (
        <form
          className="weq-qzn-space-profile-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!draft || action.disabled || !query.data) return;
            const patch = {
              ...(draft.name === query.data.name ? {} : { name: draft.name }),
              ...(draft.description === query.data.description
                ? {}
                : { description: draft.description }),
            };
            if (!Object.keys(patch).length) {
              setDraft(null);
              return;
            }
            void action.perform(
              (binding) =>
                client.account.qqActions.updateQzoneSpaceProfile.mutate({
                  ...binding,
                  hostUin,
                  ...patch,
                }),
              undefined,
              undefined,
              {
                requireReadback: true,
                readback: async () => {
                  const result = await query.refetch();
                  if (result.error) throw result.error;
                  const matched =
                    result.data?.name === draft.name &&
                    result.data?.description === draft.description;
                  if (matched) setDraft(null);
                  return matched;
                },
              },
            );
          }}
        >
          <label className="weq-set-text-field">
            <span className="weq-set-row-label">空间名称</span>
            <input
              className="weq-set-input"
              value={profile.name}
              maxLength={80}
              onChange={(event) => setDraft({ ...profile, name: event.target.value })}
            />
          </label>
          <label className="weq-set-text-field">
            <span className="weq-set-row-label">空间说明</span>
            <textarea
              className="weq-set-input"
              rows={3}
              value={profile.description}
              maxLength={512}
              onChange={(event) => setDraft({ ...profile, description: event.target.value })}
            />
          </label>
          <div className="weq-qq-action-bar">
            <button
              type="submit"
              className="weq-set-btn weq-set-btn-primary"
              disabled={action.disabled || !draft}
            >
              <Save size={15} aria-hidden />
              保存资料
            </button>
          </div>
        </form>
      ) : profile ? (
        <div>
          <Row
            label="空间名称"
            control={<span className="weq-set-row-status">{profile.name || '未填写'}</span>}
          />
          <Row
            label="空间说明"
            control={<span className="weq-set-row-status">{profile.description || '未填写'}</span>}
          />
        </div>
      ) : null}
      <ActionFeedback action={action} />
    </EditorDialog>
  );
}

export function QzoneSpaceHome({ selfUin, hostUin }: { selfUin: string; hostUin: string }) {
  const session = useQQAction(`qzone-home:${hostUin}`, 'failure-only');
  const available = session.available && session.binding?.expectedAccountUin === selfUin;
  const query = trpc.account.qqActions.qzoneHome.useInfiniteQuery(
    { ...session.binding!, hostUin },
    {
      enabled: available,
      getNextPageParam: (page, pages) =>
        page.next_cursor &&
        !pages.slice(0, -1).some((item) => item.next_cursor === page.next_cursor)
          ? page.next_cursor
          : undefined,
      retry: false,
    },
  );
  const rows = new Map<string, PublicFeedView>();
  const pages = query.data?.pages ?? [];
  for (const [pageIndex, page] of pages.entries()) {
    for (const [index, raw] of page.feeds.entries()) {
      const feed = projectPublicFeed(raw, index);
      if (!feed || feed.advertisement) continue;
      const key = feed.key.startsWith('#') ? `${pageIndex}:${feed.key}` : feed.key;
      if (!rows.has(key)) rows.set(key, feed);
    }
  }
  const cursor = pages.at(-1)?.next_cursor;
  const cursorStalled = !!cursor && pages.slice(0, -1).some((page) => page.next_cursor === cursor);
  const [selected, setSelected] = useState<{ hostUin: string; tid: string } | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const error = query.error?.message ?? '';
  const retry = () => void query.refetch();
  return (
    <div className="weq-qzn-timeline">
      <header className="weq-qzn-section-title">
        <h2>主页动态</h2>
        <button type="button" disabled={!available} onClick={() => setProfileOpen(true)}>
          <Info size={15} aria-hidden />
          空间资料
        </button>
      </header>
      {!rows.size ? (
        !available ? (
          <State
            loading={false}
            error=""
            empty="当前无法读取在线主页"
            progress="可查看「说说」或「相册」。"
          />
        ) : (
          <State
            loading={query.isFetching}
            error={error}
            empty={query.isSuccess ? '这个空间暂无可查看的主页动态。' : ''}
            retry={retry}
          />
        )
      ) : error ? (
        <State loading={false} error={error} empty="" retry={retry} />
      ) : null}
      {[...rows].map(([key, feed]) => {
        const tid = ordinaryId(feed);
        return (
          <article className="weq-qzn-post" key={key}>
            <header className="weq-qzn-post-head">
              <QzonePersonHeader
                size={36}
                url={feed.author.portrait}
                uin={feed.author.uin}
                nickname={feed.author.nick || feed.author.uin || '空间动态'}
                time={
                  feed.time ? (
                    <time>
                      <NumericText>{timeText(feed.time)}</NumericText>
                    </time>
                  ) : null
                }
              />
            </header>
            <FeedText feed={feed} />
            {tid ? (
              <QzoneActionsRow>
                <button
                  type="button"
                  onClick={() => setSelected({ hostUin: feed.author.uin, tid })}
                >
                  <FileText size={16} aria-hidden />
                  查看详情
                </button>
              </QzoneActionsRow>
            ) : null}
          </article>
        );
      })}
      {cursorStalled ? (
        <p role="alert" className="weq-qzn-status">
          主页分页未推进，请刷新核对。
        </p>
      ) : null}
      {query.hasNextPage ? (
        <button
          type="button"
          className="weq-qzn-more"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? '正在加载…' : '加载更多动态'}
        </button>
      ) : null}
      {selected && available ? (
        <OrdinaryDetail
          {...selected}
          selfUin={selfUin}
          onClose={() => setSelected(null)}
          refresh={() => query.refetch()}
        />
      ) : null}
      {profileOpen && available ? (
        <SpaceProfile selfUin={selfUin} hostUin={hostUin} onClose={() => setProfileOpen(false)} />
      ) : null}
    </div>
  );
}
