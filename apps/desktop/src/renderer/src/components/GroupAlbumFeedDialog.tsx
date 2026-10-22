import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Film, Images, Loader2, RefreshCw, X } from 'lucide-react';
import type { GroupAlbumFeedPage, GroupAlbumFeedComment } from '@weq/service';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { useQQReadActivity } from '../hooks/useQQAutoRefresh';
import type { GroupAlbumCardTarget } from '../lib/groupAlbumNavigation';
import { QzoneNavigationContext } from '../lib/qzoneNavigation';
import { qzoneTextParts } from '../lib/qzone';
import { albumMediaUrl } from '../lib/resourceUrl';
import { mergeGroupAlbumFeedPages } from '../lib/groupAlbumFeedState';
import { client } from '../trpc/client';
import { readWithRetry } from '../lib/autoRead';
import { QzoneMediaPreview, type QzonePreviewMedia } from './QzoneMediaPreview';
import { MediaSourceSave } from './MediaSaveControls';
import { OverlayLayer } from './OverlayLayer';
import { QzoneEmoji } from './QzoneEmoji';
import '../styles/group-album-browser.css';
import '../styles/group-album-feed.css';

type FeedTarget = Extract<GroupAlbumCardTarget, { kind: 'feed' }>;
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const date = (value: number | null) => {
  const timestamp = value ? new Date(value * 1000) : null;
  return timestamp && Number.isFinite(timestamp.getTime()) ? dateFormat.format(timestamp) : '';
};
function FeedText({
  content,
  onSpace,
}: {
  content: string;
  onSpace?: (uin: string, name?: string) => void;
}) {
  return (
    <>
      {qzoneTextParts(content).map((part) =>
        part.kind === 'emoji' ? (
          <QzoneEmoji
            key={`${part.offset}:${part.code}`}
            code={part.code}
            className="group-feed-emoji"
          />
        ) : part.kind === 'mention' && onSpace ? (
          <button
            key={`${part.offset}:${part.uin}`}
            type="button"
            className="group-feed-mention"
            onClick={() => onSpace(part.uin, part.text.slice(1))}
          >
            {part.text}
          </button>
        ) : (
          <span key={part.offset}>{part.text}</span>
        ),
      )}
    </>
  );
}
function Comment({
  row,
  onSpace,
}: {
  row: GroupAlbumFeedComment;
  onSpace?: (uin: string, name?: string) => void;
}) {
  return (
    <li className="group-feed-comment" data-comment-id={row.id}>
      <div className="group-feed-comment-meta">
        <strong>{row.author.name || row.author.uin || '未知作者'}</strong>
        <time>{date(row.time)}</time>
      </div>
      <p>{row.content ? <FeedText content={row.content} onSpace={onSpace} /> : '（无文字内容）'}</p>
      {row.replies.length ? (
        <ol className="group-feed-replies">
          {row.replies.map((reply) => (
            <Comment key={reply.id} row={reply} onSpace={onSpace} />
          ))}
        </ol>
      ) : null}
      {row.totalReplies !== null && row.totalReplies > row.replies.length ? (
        <small>
          已返回 {row.replies.length} / {row.totalReplies} 条回复
        </small>
      ) : null}
    </li>
  );
}
function MediaThumb({ item, video = false }: { item: QzonePreviewMedia; video?: boolean }) {
  const isVideo = video || item.kind === 'video';
  const source = item.poster || (item.kind === 'image' ? item.src : '');
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  return (
    <>
      {source && !failed ? (
        <img src={source} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="group-feed-media-fallback">
          {isVideo ? <Film size={24} /> : <Images size={24} />}
        </span>
      )}
      {isVideo && source && !failed ? <Film size={20} /> : null}
    </>
  );
}

interface FeedDialogProps {
  target: FeedTarget;
  binding: QQWriteBinding;
  groupName: string;
  onClose: () => void;
  onOpenAlbum: () => void;
}
export function GroupAlbumFeedDialog(props: FeedDialogProps) {
  const { target, binding } = props;
  return (
    <GroupAlbumFeedBody
      key={JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId, target])}
      {...props}
    />
  );
}
function GroupAlbumFeedBody({ target, binding, groupName, onClose, onOpenAlbum }: FeedDialogProps) {
  const activity = useQQReadActivity(true);
  const onNavigate = useContext(QzoneNavigationContext);
  const input = useMemo(
    () => ({
      expectedAccountUin: binding.expectedAccountUin,
      expectedAccountConfigId: binding.expectedAccountConfigId,
      groupCode: target.groupCode,
      albumId: target.albumId,
      batchId: target.batchId,
      ...(target.legacyFocus ? { legacyFocus: target.legacyFocus } : {}),
    }),
    [
      binding.expectedAccountUin,
      binding.expectedAccountConfigId,
      target.groupCode,
      target.albumId,
      target.batchId,
      target.legacyFocus,
    ],
  );
  const [page, setPage] = useState<GroupAlbumFeedPage | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string>(),
    [revision, setRevision] = useState(0),
    [previewId, setPreviewId] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [visibleMedia, setVisibleMedia] = useState(60);
  const generation = useRef(0),
    autoOpened = useRef(false);
  const pageRef = useRef<GroupAlbumFeedPage | null>(null);
  const seenCursors = useRef(new Set<string>());
  useEffect(() => {
    if (!activity.enabled) {
      setLoading(false);
      return;
    }
    const run = ++generation.current,
      controller = new AbortController();
    setLoading(true);
    setError(null);
    void readWithRetry(
      () =>
        client.account.getGroupAlbumFeed.query(
          { ...input, ...(cursor ? { cursor } : {}) },
          { signal: controller.signal },
        ),
      controller.signal,
    )
      .then((value) => {
        if (controller.signal.aborted || generation.current !== run) return;
        if (
          cursor &&
          value.hasMore &&
          value.nextCursor &&
          (value.nextCursor === cursor || seenCursors.current.has(value.nextCursor))
        )
          throw new Error('群相册评论分页位置重复，未合并本页');
        const next = cursor ? mergeGroupAlbumFeedPages(pageRef.current, value) : value;
        if (!cursor) seenCursors.current.clear();
        else seenCursors.current.add(cursor);
        pageRef.current = next;
        setPage(next);
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted && generation.current === run)
          setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted && generation.current === run) setLoading(false);
      });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [input, cursor, revision, activity.enabled, activity.revision]);
  const previews = useMemo<QzonePreviewMedia[]>(
    () =>
      (page?.media ?? [])
        .filter((item) => item.url || item.previewUrl)
        .map((item) => ({
          key: item.id,
          kind: item.kind === 'video' && item.url ? 'video' : 'image',
          src: albumMediaUrl(item.url || item.previewUrl),
          poster: item.previewUrl ? albumMediaUrl(item.previewUrl) : undefined,
          title:
            item.kind === 'video' && !item.url
              ? '视频本体未返回，仅封面'
              : item.kind === 'video'
                ? '群相册视频'
                : '群相册图片',
        })),
    [page?.media],
  );
  const previewById = useMemo(() => new Map(previews.map((item) => [item.key, item])), [previews]);
  useEffect(() => {
    if (!page || !target.mediaId) return;
    const found = previewById.has(target.mediaId);
    setMediaError(
      found
        ? null
        : page.media.some((item) => item.id === target.mediaId)
          ? '卡片指定的媒体地址未返回，暂不可预览。'
          : '未找到卡片指定的媒体，未自动打开其它媒体。',
    );
    if (found && !autoOpened.current) {
      autoOpened.current = true;
      setPreviewId(target.mediaId);
    }
  }, [page, previewById, target.mediaId]);
  const onSpace = onNavigate
    ? (uin: string, name?: string) => {
        onClose();
        onNavigate(uin, name);
      }
    : undefined;
  const refresh = () => {
    setCursor(undefined);
    setRevision((value) => value + 1);
    setPreviewId(null);
    autoOpened.current = false;
    setMediaError(null);
  };
  return (
    <OverlayLayer
      presentation="sidecar"
      title="群相册动态"
      className="modal-scrim group-album-scrim"
      onClose={onClose}
    >
      <section
        className="group-album-dialog group-album-browser group-album-feed"
        role="region"
        aria-label={`${groupName}的群相册动态`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <strong title={page?.albumName}>{page?.albumName || '群相册动态'}</strong>
            <span title={groupName}>{groupName}</span>
          </div>
          <button
            type="button"
            className="group-album-tool"
            aria-label="关闭群相册动态"
            title="关闭"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="group-album-body group-feed-body" aria-busy={loading}>
          <div className="group-feed-overview">
            <div className="group-feed-meta">
              <span>{page?.author.name || page?.author.uin || ''}</span>
              <time>{date(page?.time ?? null)}</time>
              <span>批次 {target.batchId}</span>
            </div>
            <div className="group-feed-tools">
              <button
                type="button"
                className="group-album-tool"
                aria-label="打开所属相册"
                title="打开所属相册"
                onClick={onOpenAlbum}
              >
                <Images size={17} />
              </button>
              <button
                type="button"
                className="group-album-tool"
                aria-label="刷新动态"
                title="刷新动态"
                disabled={loading || !activity.enabled}
                onClick={refresh}
              >
                <RefreshCw size={17} />
              </button>
            </div>
          </div>
          {error ? (
            <div className="group-album-read-error" role="alert">
              {error}
              <button
                type="button"
                className="group-album-tool"
                aria-label="重试读取动态"
                title="重试读取动态"
                disabled={loading || !activity.enabled}
                onClick={() => setRevision((value) => value + 1)}
              >
                <RefreshCw size={15} />
              </button>
            </div>
          ) : null}
          {mediaError ? (
            <p className="group-album-read-error" role="alert">
              {mediaError}
            </p>
          ) : null}
          {!activity.enabled ? (
            <p role="status" className="group-feed-muted">
              读取已暂停
            </p>
          ) : null}
          {loading && !page ? (
            <div className="group-album-state" role="status">
              <Loader2 size={18} className="weq-spin" />
              正在读取动态
            </div>
          ) : null}
          {page ? (
            <>
              <div className="group-feed-media">
                {page.media.slice(0, visibleMedia).map((media) => {
                  const preview = previewById.get(media.id);
                  const item: QzonePreviewMedia = preview ?? {
                    key: media.id,
                    kind: media.kind,
                    src: '',
                    title: '媒体地址未返回',
                  };
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className="group-feed-media-item"
                      data-album-feed-media={item.key}
                      aria-label={item.title}
                      title={item.title}
                      disabled={!preview}
                      onClick={() => {
                        autoOpened.current = true;
                        setPreviewId(item.key);
                      }}
                    >
                      <MediaThumb item={item} video={media.kind === 'video'} />
                    </button>
                  );
                })}
              </div>
              {page.media.length > visibleMedia ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  onClick={() => setVisibleMedia((value) => value + 60)}
                >
                  显示更多媒体
                </button>
              ) : null}
              <p className="group-feed-muted">
                本次返回 {page.media.length} 项媒体
                {page.totalMedia !== null && page.totalMedia > page.media.length
                  ? ` / 共 ${page.totalMedia} 项`
                  : ''}
                {visibleMedia < page.media.length ? `，当前显示 ${visibleMedia} 项` : ''}
              </p>
              <div className="group-feed-discussion-head">
                <h3>评论</h3>
                <span>
                  {page.totalComments === null || page.totalComments < page.comments.length
                    ? `已返回 ${page.comments.length} 条`
                    : `已返回 ${page.comments.length} / ${page.totalComments} 条`}
                </span>
              </div>
              {page.comments.length ? (
                <ol className="group-feed-comments">
                  {page.comments.map((row) => (
                    <Comment key={row.id} row={row} onSpace={onSpace} />
                  ))}
                </ol>
              ) : (
                <p className="group-feed-muted">
                  {page.totalComments === 0 ? '暂无评论' : '本次响应未返回评论'}
                </p>
              )}
              {page.hasMore && page.nextCursor ? (
                <button
                  type="button"
                  className="weq-set-btn weq-set-btn-soft"
                  disabled={loading || !activity.enabled}
                  onClick={() => {
                    setCursor(page.nextCursor!);
                    setRevision((value) => value + 1);
                  }}
                >
                  {loading ? <Loader2 size={14} className="weq-spin" /> : null}加载更多评论
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {previewId && previews.some((item) => item.key === previewId) ? (
          <QzoneMediaPreview
            key={previewId}
            items={previews}
            initialIndex={previews.findIndex((item) => item.key === previewId)}
            label="群相册动态媒体预览"
            onClose={() => setPreviewId(null)}
            renderActions={(item) => {
              const media = page?.media.find((row) => row.id === item.key);
              const coverOnly = media?.kind === 'video' && !media.url;
              return (
                <div className="group-album-preview-details">
                  {coverOnly ? (
                    <p className="group-feed-muted">视频本体未返回，仅显示封面。</p>
                  ) : null}
                  <MediaSourceSave
                    className="group-album-preview-save"
                    source={{
                      kind: 'url',
                      url: item.src,
                      name: coverOnly
                        ? '群相册视频封面'
                        : item.kind === 'video'
                          ? '群相册视频'
                          : '群相册图片',
                    }}
                    label={
                      coverOnly ? '保存视频封面' : item.kind === 'video' ? '保存视频' : '保存图片'
                    }
                  />
                </div>
              );
            }}
          />
        ) : null}
      </section>
    </OverlayLayer>
  );
}
