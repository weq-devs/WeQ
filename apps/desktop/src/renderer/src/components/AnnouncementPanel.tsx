import { useEffect, useLayoutEffect, useRef } from 'react';
import { ArrowLeft, ChevronRight, RefreshCw, X } from 'lucide-react';
import { Streamdown } from 'streamdown';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { APP_NAVIGATION } from '../lib/appNavigation';
import { openExternalLink } from '../lib/openExternalLink';
import { useMobileWebLayout } from '../hooks/useMobileWebViewport';
import { trpc } from '../trpc/client';
import { Modal } from './Dialog';
import { useDialog } from './Dialog.shared';
import { ReminderDot } from './ReminderBadge';

type AnnouncementList = inferRouterOutputs<AppRouter>['announcements']['list'];
const title = APP_NAVIGATION.announcements.label;
const dateFormatter = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' });
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
          void openExternalLink(url)
            .then(({ ok, error }) => {
              if (!ok) useDialog.getState().showError('无法打开链接', error ?? '请稍后重试');
            })
            .catch(() => useDialog.getState().showError('无法打开链接', '请稍后重试'));
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
  list,
  listFailed,
}: {
  selected: string | null;
  onSelect: (id: string | null) => void;
  onClose: () => void;
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
  const unreadIds = list?.entries.filter(({ unread }) => unread).map(({ id }) => id) ?? [];

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
          <>
            <button
              type="button"
              className="weq-set-btn"
              disabled={!unreadIds.length || mark.isLoading}
              onClick={() => mutate(unreadIds)}
            >
              全部标为已读
            </button>
            <button
              type="button"
              className="weq-workspace-control"
              title="刷新公告"
              aria-label="刷新公告"
              disabled={refresh.isLoading}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw
                size={16}
                className={refresh.isLoading ? 'weq-spin' : undefined}
                aria-hidden
              />
            </button>
          </>
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
                <time dateTime={visibleDetail.publishedAt}>
                  {dateFormatter.format(new Date(visibleDetail.publishedAt))}
                </time>
                {visibleDetail.level === 'important' && <span>重要</span>}
              </div>
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
          ) : (
            <p className="weq-announcement-empty" role="status">
              {details.isError
                ? '无法读取这条公告。'
                : details.isLoading
                  ? '正在读取公告…'
                  : '这条公告已不可查看。'}
              {details.isError && (
                <button
                  type="button"
                  className="weq-set-btn"
                  onClick={() => void details.refetch()}
                >
                  重试
                </button>
              )}
            </p>
          )
        ) : (
          <>
            {list?.status === 'cached' && (
              <p className="weq-announcement-status" role="status">
                显示上次获取的公告
              </p>
            )}
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
                          <time dateTime={entry.publishedAt}>
                            {dateFormatter.format(new Date(entry.publishedAt))}
                          </time>
                          {entry.level === 'important' && <span>重要</span>}
                        </span>
                      </span>
                      {entry.unread && <ReminderDot aria-label="未读" />}
                      <ChevronRight size={16} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="weq-announcement-empty" role="status">
                {listFailed || refresh.isError || list?.status === 'unavailable'
                  ? '暂时无法获取公告。'
                  : !list || list.status === 'loading'
                    ? '正在获取公告…'
                    : '暂无官方公告'}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
