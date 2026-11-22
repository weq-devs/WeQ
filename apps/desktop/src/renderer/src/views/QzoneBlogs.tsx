import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { timeDate } from '@weq/time';
import { FileText, MessageCircle } from 'lucide-react';
import {
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { NumericText } from '../components/NumericText';
import { QzoneActionsRow } from '../components/QzoneActionsRow';
import { QzoneCommentRow } from '../components/QzoneCommentRow';
import { QzonePersonHeader } from '../components/QzoneProfileAvatar';
import { QzoneTime } from '../components/QzoneTime';
import { useQzoneRequests } from '../hooks/useQzoneRequests';
import { openExternalLink } from '../lib/openExternalLink';
import { qzoneMediaSource } from '../lib/qzone';
import { albumMediaUrl } from '../lib/resourceUrl';
import { client, trpc } from '../trpc/client';
import { LoadingStatus, QzoneMediaGrid, State } from './qzoneShared';
import { QzoneAutoPage } from './QzonePagination';
import { QzonePageContext } from './qzoneShared.shared';

type BlogInput = Omit<
  Parameters<typeof client.account.qzone.blog.query>[0],
  'requestId' | 'blogId'
>;
export type QzoneBlog = Awaited<
  ReturnType<typeof client.account.qzone.blogs.query>
>['items'][number];
type Page<T> = { items: T[]; nextOffset: number | null };

/** QQ 的十位日志编号编码了发表时间；其他编号仍用列表提供的时间。 */
export function qzoneBlogTime(blog: Pick<QzoneBlog, 'id' | 'publishedAt'>): number | string {
  const time = Number(blog.id);
  return /^[1-9]\d{9}$/.test(blog.id) && time <= Date.now() / 1000 ? time : blog.publishedAt.trim();
}

export function qzoneBlogSortTime(blog: QzoneBlog): number {
  const value = qzoneBlogTime(blog);
  return typeof value === 'number' ? value : (timeDate(value)?.getTime() ?? 0) / 1000;
}

function repeatedPage<T extends { id: string }>(last: Page<T>, pages: Page<T>[]) {
  if (pages.length < 2 || !last.items.length) return false;
  const previous = new Set(pages.slice(0, -1).flatMap((page) => page.items.map(({ id }) => id)));
  return last.items.every(({ id }) => previous.has(id));
}

function blogItems<T extends { id: string }>(pages: Page<T>[]) {
  const items = new Map<string, T>();
  for (const page of pages)
    for (const item of page.items) if (!items.has(item.id)) items.set(item.id, item);
  return [...items.values()];
}

function nextPage<T extends { id: string }>(last: Page<T>, pages: Page<T>[]) {
  return repeatedPage(last, pages) ? undefined : (last.nextOffset ?? undefined);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : error ? '读取 QQ 空间日志失败，请重试。' : '';
}

function normalizedUrl(value: string) {
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    return url.href;
  } catch {
    return '';
  }
}

const blogTextTags = new Set([
  'b',
  'blockquote',
  'br',
  'code',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'wbr',
]);

/** 从惰性模板投影为原生节点，只从地址白名单取图，不挂载 QQ 的 DOM。 */
function renderBlogNodes(parent: ParentNode, depth = 0): ReactNode[] {
  if (depth > 64) return [];
  return [...parent.childNodes].flatMap((node, index): ReactNode[] => {
    if (node.nodeType === Node.TEXT_NODE) return [node.textContent];
    if (!(node instanceof HTMLElement)) return [];
    const tag = node.localName;
    const key = `${tag}:${index}`;
    if (tag === 'img') {
      const source =
        qzoneMediaSource(node.getAttribute('orgsrc') || '') ??
        qzoneMediaSource(node.getAttribute('src') || '');
      return source
        ? [
            <img
              key={key}
              src={albumMediaUrl(source)}
              alt={node.getAttribute('alt') || ''}
              loading="lazy"
            />,
          ]
        : [];
    }
    if (tag === 'a') {
      const href = normalizedUrl(node.getAttribute('href') || '');
      const children = renderBlogNodes(node, depth + 1);
      return href
        ? [
            <a
              key={key}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => {
                event.preventDefault();
                void openExternalLink(href);
              }}
            >
              {children}
            </a>,
          ]
        : [<span key={key}>{children}</span>];
    }
    if (tag === 'font' || tag === 'center')
      return [<span key={key}>{renderBlogNodes(node, depth + 1)}</span>];
    if (!blogTextTags.has(tag)) return [];
    const children = renderBlogNodes(node, depth + 1);
    return [children.length ? createElement(tag, { key }, children) : createElement(tag, { key })];
  });
}

function BlogBody({ html }: { html: string }) {
  const content = useMemo(() => {
    const template = document.createElement('template');
    template.innerHTML = html;
    return renderBlogNodes(template.content);
  }, [html]);
  if (!content.length) return <p className="weq-qzn-status">这篇日志暂无可展示的正文</p>;
  return (
    <div className="weq-qzn-content weq-qzn-blog-body" data-privacy-sensitive>
      {content}
    </div>
  );
}

export function QzoneBlogCard({
  blog,
  input,
  nickname,
  onSpace,
  timeline,
}: {
  blog: QzoneBlog;
  input: BlogInput;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
  timeline?: {
    time: number;
    portrait: string;
    preview?: ReactNode;
    tools?: ReactNode;
    counts?: ReactNode;
  };
}) {
  const { active } = useContext(QzonePageContext);
  const { run } = useQzoneRequests();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const scoped = useMemo(() => ({ ...input, blogId: blog.id }), [input, blog.id]);
  useEffect(() => {
    if (!active) void queryClient.cancelQueries({ queryKey: ['qzone-blog', scoped] });
  }, [active, queryClient, scoped]);
  const detail = useQuery({
    queryKey: ['qzone-blog', scoped, 'detail'],
    queryFn: ({ signal }) =>
      run((requestId) => client.account.qzone.blog.query({ ...scoped, requestId }), false, signal),
    enabled: active && expanded,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const comments = useInfiniteQuery({
    queryKey: ['qzone-blog', scoped, 'comments'],
    queryFn: ({ pageParam = 0, signal }) =>
      run(
        (requestId) =>
          client.account.qzone.blogComments.query({ ...scoped, requestId, offset: pageParam }),
        false,
        signal,
      ),
    enabled: active && commentsOpen,
    getNextPageParam: nextPage,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const commentPages = comments.data?.pages ?? [];
  const commentItems = blogItems(commentPages);
  const lastCommentPage = commentPages.at(-1);
  const commentsRepeated = lastCommentPage && repeatedPage(lastCommentPage, commentPages);
  return (
    <article className="weq-qzn-post">
      <header className="weq-qzn-post-head">
        <QzonePersonHeader
          size={36}
          url={timeline?.portrait}
          uin={input.hostUin}
          nickname={nickname || input.hostUin}
          onSpace={onSpace}
          time={<QzoneTime value={timeline?.time || qzoneBlogTime(blog)} />}
        />
        {timeline ? <span className="weq-qzn-feed-kind">日志</span> : null}
        {timeline?.tools}
      </header>
      <h3 className="weq-qzn-blog-title" data-privacy-sensitive>
        {blog.title || '未命名日志'}
      </h3>
      {expanded && detail.data ? (
        <BlogBody html={detail.data.html} />
      ) : (
        <>
          {blog.summary ? <BlogBody html={blog.summary} /> : timeline?.preview}
          <QzoneMediaGrid images={blog.images} videos={[]} />
        </>
      )}
      {expanded && detail.isFetching ? <LoadingStatus text="正在读取全文…" /> : null}
      {expanded && detail.error ? (
        <State
          loading={false}
          error={errorText(detail.error)}
          empty=""
          retry={() => void detail.refetch()}
        />
      ) : null}
      <QzoneActionsRow>
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <FileText size={16} aria-hidden />
          <span className="weq-qzn-action-label">{expanded ? '收起全文' : '查看全文'}</span>
        </button>
        <button
          type="button"
          aria-expanded={commentsOpen}
          onClick={() => setCommentsOpen(!commentsOpen)}
        >
          <MessageCircle size={16} aria-hidden />
          <span className="weq-qzn-action-label">评论</span>
          {blog.commentCount !== null ? (
            <>
              {' '}
              <NumericText>{blog.commentCount}</NumericText>
            </>
          ) : null}
        </button>
        {timeline?.counts}
      </QzoneActionsRow>
      {commentsOpen ? (
        <section className="weq-qzn-interaction" aria-label="日志评论">
          {commentItems.map((comment) => (
            <QzoneCommentRow
              key={comment.id}
              uin={comment.uin}
              nickname={comment.nickname}
              time={comment.time}
              onSpace={onSpace}
            >
              <p data-privacy-sensitive>{comment.text}</p>
            </QzoneCommentRow>
          ))}
          {comments.error || !commentItems.length || commentsRepeated ? (
            <State
              loading={comments.isFetching && !commentItems.length}
              error={
                errorText(comments.error) ||
                (commentsRepeated ? '日志评论分页未推进，请刷新核对。' : '')
              }
              empty={comments.isSuccess ? '暂无评论' : ''}
              retry={() =>
                void (comments.error && comments.hasNextPage
                  ? comments.fetchNextPage()
                  : comments.refetch())
              }
            />
          ) : null}
          {comments.hasNextPage && !comments.error ? (
            <QzoneAutoPage
              key={commentPages.length}
              loading={comments.isFetching}
              onNext={() => void comments.fetchNextPage({ cancelRefetch: false })}
            />
          ) : null}
        </section>
      ) : null}
    </article>
  );
}

export function useQzoneBlogIndex({
  selfUin,
  hostUin,
  active,
  refresh,
}: {
  selfUin: string;
  hostUin: string;
  active: boolean;
  refresh: number;
}) {
  const config = trpc.account.getAccountConfig.useQuery(undefined, { enabled: active });
  const configId = config.data?.uin === selfUin ? config.data.configId : undefined;
  const input = useMemo(
    () => ({ selfUin, hostUin, expectedAccountConfigId: configId ?? '' }),
    [selfUin, hostUin, configId],
  );
  const { run } = useQzoneRequests();
  const queryClient = useQueryClient();
  const { refetch, fetchNextPage, ...query } = useInfiniteQuery({
    queryKey: ['qzone-blogs', input],
    queryFn: ({ pageParam = 0, signal }) =>
      run(
        (requestId) => client.account.qzone.blogs.query({ ...input, requestId, offset: pageParam }),
        false,
        signal,
      ),
    enabled: active && Boolean(configId),
    getNextPageParam: nextPage,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const previousRefresh = useRef(refresh);
  useEffect(() => {
    if (!active) {
      void queryClient.cancelQueries({ queryKey: ['qzone-blogs', input], exact: true });
      return;
    }
    if (!configId || previousRefresh.current === refresh) return;
    previousRefresh.current = refresh;
    void refetch();
  }, [active, configId, refresh, input, queryClient, refetch]);
  const pages = query.data?.pages ?? [];
  const items = useMemo(() => blogItems(query.data?.pages ?? []), [query.data?.pages]);
  const last = pages.at(-1);
  const repeated = last && repeatedPage(last, pages);
  const error =
    errorText(config.error) ||
    errorText(query.error) ||
    (repeated
      ? '日志分页未推进，请刷新核对。'
      : active && config.isSuccess && !configId
        ? '当前账号尚未就绪，请重新打开日志。'
        : '');
  const loading = config.isFetching || query.isFetching;
  return {
    input,
    configId,
    items,
    total: pages[0]?.total,
    pages: pages.length,
    atEnd: last?.nextOffset === null,
    error,
    loading,
    success: query.isSuccess,
    hasNextPage: query.hasNextPage,
    next: () => void fetchNextPage({ cancelRefetch: false }),
    retry: () => {
      if (!configId) void config.refetch();
      else if (query.error && query.hasNextPage) void fetchNextPage();
      else void refetch();
    },
  };
}

export type QzoneBlogIndex = ReturnType<typeof useQzoneBlogIndex>;

export function QzoneBlogs({
  index,
  nickname,
  onSpace,
}: {
  index: QzoneBlogIndex;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
}) {
  const { items, input, configId, error, loading } = index;
  return (
    <div className="weq-qzn-timeline">
      {items.map((item) => (
        <QzoneBlogCard
          key={`${configId}:${item.id}`}
          blog={item}
          input={input}
          nickname={nickname}
          onSpace={onSpace}
        />
      ))}
      {error || !items.length ? (
        <State
          loading={loading && !items.length}
          error={error}
          empty={index.success ? '这个空间暂无可查看的日志' : ''}
          retry={index.retry}
        />
      ) : null}
      {index.hasNextPage && !error ? (
        <QzoneAutoPage key={index.pages} loading={loading} onNext={index.next} />
      ) : null}
      {!error && index.atEnd && items.length ? (
        <p className="weq-qzn-status">已到列表末尾</p>
      ) : null}
    </div>
  );
}
