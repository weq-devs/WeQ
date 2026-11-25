import { useEffect, useLayoutEffect, useRef } from 'react';
import { formatDate } from '@weq/time';
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CloudOff,
  ExternalLink,
  FileQuestion,
  Megaphone,
  X,
} from 'lucide-react';
import { Streamdown } from 'streamdown';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { APP_NAVIGATION } from '../lib/appNavigation';
import { openExternalLink } from '../lib/openExternalLink';
import { notificationSource, openNotificationSource } from '../lib/notificationNavigation.shared';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { EmptyState } from './EmptyState';
import { LoadingIndicator } from './LoadingIndicator';
import { useDialog } from './Dialog.shared';
import { ReminderDot } from './ReminderBadge';
import { TimeLabel } from './TimeLabel';

type AnnouncementList = inferRouterOutputs<AppRouter>['announcements']['list'];
const title = APP_NAVIGATION.announcements.label;
const noRehypePlugins: [] = [];

function httpsLink(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {
    // 正文不解析相对链接。
  }
  return '';
}

function openAnnouncementLink(url: string) {
  void openExternalLink(url)
    .then(({ ok, error }) => {
      if (!ok) useDialog.getState().showError('无法打开链接', error ?? '请稍后重试');
    })
    .catch(() => useDialog.getState().showError('无法打开链接', '请稍后重试'));
}

const markdownComponents: NonNullable<React.ComponentProps<typeof Streamdown>['components']> = {
  a({ href, children }) {
    const url = href ? httpsLink(href) : '';
    if (!url) return <span>{children}</span>;
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          openAnnouncementLink(url);
        }}
      >
        {children}
      </a>
    );
  },
};

export default function AnnouncementPanel({
  selected,
  onSelect,
  onClose,
  canOpenUpdateSettings,
  list,
  listFailed,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
  canOpenUpdateSettings: boolean;
  list?: AnnouncementList;
  listFailed: boolean;
}) {
  const mobile = useMobileWebLayout();
  const utils = trpc.useUtils();
  const details = trpc.announcements.detail.useQuery(selected ?? '', {
    enabled: selected !== null,
    retry: false,
  });
  const refresh = trpc.announcements.refresh.useMutation({
    onSettled: () => utils.announcements.list.invalidate(),
  });
  const { mutate: refreshFeed } = refresh;
  useEffect(() => refreshFeed({ ifStale: true }), [refreshFeed]);
  const mark = trpc.announcements.markRead.useMutation({
    onSettled: () => utils.announcements.list.invalidate(),
  });
  const { mutate, reset } = mark;
  const requested = useRef<string | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const listPosition = useRef(0);
  const returnTo = useRef<string | null>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  const visibleDetail = selected !== null && details.data?.id === selected ? details.data : null;
  const visibleId = visibleDetail?.id;
  const releasePageUrl = visibleDetail?.releasePageUrl;
  const unreadIds = list?.entries.filter(({ unread }) => unread).map(({ id }) => id) ?? [];
  const hasEntries = Boolean(list?.entries.length);
  const feedFailed =
    listFailed || refresh.isError || list?.status === 'unavailable' || list?.status === 'cached';

  useEffect(() => {
    if (!visibleDetail || requested.current === visibleDetail.id) return;
    requested.current = visibleDetail.id;
    mutate([visibleDetail.id]);
  }, [mutate, visibleDetail]);

  useLayoutEffect(() => {
    if (!scroll.current) return;
    scroll.current.scrollTop = selected ? 0 : listPosition.current;
    if (!selected && returnTo.current)
      scroll.current
        .querySelector<HTMLButtonElement>(`[data-announcement-id="${returnTo.current}"]`)
        ?.focus({ preventScroll: true });
  }, [selected]);
  useLayoutEffect(() => {
    if (visibleId) detailTitle.current?.focus({ preventScroll: true });
  }, [visibleId]);

  const visit = (id: string | null) => {
    if (id) {
      listPosition.current = scroll.current?.scrollTop ?? 0;
      returnTo.current = id;
    }
    requested.current = null;
    reset();
    onSelect(id);
  };
  const closeOrBack = () => (selected ? visit(null) : onClose());
  const openUpdateSettings = () => {
    onClose();
    openNotificationSource(
      notificationSource(
        {
          kind: 'app',
          target: { kind: 'setting', section: 'version', settingId: 'software-update' },
        },
        '前往更新',
        null,
      ),
    );
  };

  return (
    <Modal
      title={title}
      width={640}
      centered
      presentation={mobile ? 'page' : 'modal'}
      onClose={mobile ? closeOrBack : onClose}
      labelledBy="weq-announcement-title"
      className="weq-announcements-panel"
      focusContainerOnOpen
    >
      <header className="weq-announcements-head">
        {(selected || mobile) && (
          <button
            type="button"
            className="weq-workspace-control"
            title="返回"
            aria-label="返回"
            onClick={closeOrBack}
          >
            <ArrowLeft size={18} aria-hidden />
          </button>
        )}
        <h2 id="weq-announcement-title">{title}</h2>
        {!selected && (
          <button
            type="button"
            className="weq-set-btn"
            disabled={!unreadIds.length || mark.isLoading}
            onClick={() => mutate(unreadIds)}
          >
            全部标为已读
          </button>
        )}
        {!mobile && (
          <button
            type="button"
            className="weq-workspace-control"
            title="关闭"
            aria-label="关闭公告"
            onClick={onClose}
          >
            <X size={18} aria-hidden />
          </button>
        )}
      </header>
      {mark.isError && (
        <div className="weq-announcement-status" role="alert">
          已读状态未保存
          <button
            type="button"
            className="weq-set-btn"
            onClick={() => mutate(mark.variables ?? [])}
          >
            重试
          </button>
        </div>
      )}
      <div className="weq-announcements-scroll" ref={scroll}>
        {selected ? (
          visibleDetail ? (
            <article className="weq-announcement-article">
              <h3 ref={detailTitle} tabIndex={-1}>
                {visibleDetail.title}
              </h3>
              <div className="weq-announcement-meta">
                <TimeLabel value={visibleDetail.publishedAt} />
                {visibleDetail.level === 'important' && <span>重要</span>}
              </div>
              {releasePageUrl && (
                <button
                  type="button"
                  className="weq-set-btn mb-4"
                  onClick={
                    canOpenUpdateSettings
                      ? openUpdateSettings
                      : () => openAnnouncementLink(releasePageUrl)
                  }
                >
                  {canOpenUpdateSettings ? (
                    <>
                      前往更新 <ArrowRight size={14} aria-hidden />
                    </>
                  ) : (
                    <>
                      查看发布页 <ExternalLink size={14} aria-hidden />
                    </>
                  )}
                </button>
              )}
              <Streamdown
                mode="static"
                skipHtml
                disallowedElements={['img']}
                rehypePlugins={noRehypePlugins}
                urlTransform={(url, key) => (key === 'href' ? httpsLink(url) : '')}
                components={markdownComponents}
                controls={false}
              >
                {visibleDetail.body}
              </Streamdown>
            </article>
          ) : details.isLoading ? (
            <div className="weq-announcement-placeholder" role="status">
              <LoadingIndicator>正在读取公告…</LoadingIndicator>
            </div>
          ) : details.isError ? (
            <div className="weq-announcement-placeholder">
              <EmptyState
                icon={<FileQuestion />}
                title="无法读取这条公告"
                body="网络或服务暂时不可用，可以稍后重试。"
              />
              <button type="button" className="weq-set-btn" onClick={() => void details.refetch()}>
                重试
              </button>
            </div>
          ) : (
            <div className="weq-announcement-placeholder">
              <EmptyState
                icon={<FileQuestion />}
                title="这条公告已不可查看"
                body="它可能已被撤下，或当前账号没有查看权限。"
              />
              <button type="button" className="weq-set-btn" onClick={() => visit(null)}>
                返回公告列表
              </button>
            </div>
          )
        ) : (
          <>
            {feedFailed && hasEntries ? (
              <p className="weq-announcement-status" role="status">
                暂时无法获取最新公告，显示上次获取的内容。
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={refresh.isLoading}
                  onClick={() => refreshFeed(undefined)}
                >
                  {refresh.isLoading ? '正在获取…' : '重试'}
                </button>
              </p>
            ) : null}
            {feedFailed && !hasEntries ? (
              <div className="weq-announcement-placeholder">
                <EmptyState
                  icon={<CloudOff />}
                  title="暂时无法获取公告"
                  body="网络或服务暂时不可用，恢复后可以在这里重试。"
                />
                <button
                  type="button"
                  className="weq-set-btn"
                  disabled={refresh.isLoading}
                  onClick={() => refreshFeed(undefined)}
                >
                  {refresh.isLoading ? '正在获取…' : '重试'}
                </button>
              </div>
            ) : null}
            {list?.entries.length ? (
              <ul className="weq-announcements-list">
                {list.entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      data-announcement-id={entry.id}
                      data-unread={entry.unread}
                      onClick={() => visit(entry.id)}
                    >
                      <span className="weq-announcement-row-copy">
                        <strong>{entry.title}</strong>
                        <span className="weq-announcement-meta">
                          <TimeLabel value={entry.publishedAt} tabbable={false}>
                            {formatDate(entry.publishedAt)}
                          </TimeLabel>
                          {entry.level === 'important' && <span>重要</span>}
                        </span>
                      </span>
                      {entry.unread && <ReminderDot aria-label="未读" />}
                      <ChevronRight size={16} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : !feedFailed ? (
              !list || list.status === 'loading' || refresh.isLoading ? (
                <div className="weq-announcement-placeholder" role="status">
                  <LoadingIndicator>正在获取公告…</LoadingIndicator>
                </div>
              ) : (
                <div className="weq-announcement-placeholder">
                  <EmptyState
                    icon={<Megaphone />}
                    title="暂时没有公告"
                    body="官方公告发布后会出现在这里；有更新时入口会亮起红点。"
                  />
                  <button
                    type="button"
                    className="weq-set-btn"
                    disabled={refresh.isLoading}
                    onClick={() => refreshFeed(undefined)}
                  >
                    刷新
                  </button>
                </div>
              )
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}
