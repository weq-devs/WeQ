/** Qzone's known web capabilities, rendered in the local WeQ UI. */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from 'react';
import { ImagePlus, Loader2, MessageCircle, RefreshCw, Send, ThumbsUp, X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from '../components/QqAvatar';
import { QzoneAlbumDialog } from '../components/QzoneAlbumDialog';
import { openLightbox } from '../components/ImageLightbox';
import { openVideoLightbox } from '../components/VideoLightbox';
import { albumMediaUrl, avatarFetchUrl } from '../lib/resourceUrl';
import { projectQzoneFeed, qzoneMediaSource, mergeQzonePosts, qzoneTextParts } from '../lib/qzone';
import { Modal } from '../components/Dialog';
import type { QzoneEmotion, QzoneFeed, QzoneInteraction, QzoneLikesResult } from './qzone_types';
import '../styles/qzone.css';
import { QZONE_VISIBILITY } from '../../../shared/qzone';

type Tab = 'feeds' | 'posts' | 'albums' | 'space';
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '加载失败，请重试。';
function timeText(time: number): string {
  return time ? new Date(time * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
}

let activeReads = 0;
const readQueue: (() => void)[] = [];
function queueQzoneRead<T>(work: () => Promise<T>, background: boolean): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = (): void => {
      activeReads++;
      void Promise.resolve()
        .then(work)
        .then(resolve, reject)
        .finally(() => {
          activeReads--;
          readQueue.shift()?.();
        });
    };
    if (activeReads < 2) start();
    else if (background) readQueue.push(start);
    else readQueue.unshift(start);
  });
}

function useNearViewport(ref: RefObject<HTMLElement | null>, once = false): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((entry) => entry.isIntersecting);
        setNear(visible);
        if (visible && once) observer.disconnect();
      },
      { root: element.closest('.weq-qzn-scroll'), rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, once]);
  return near;
}

/** Nicknames share the emoji renderer, but never introduce nested buttons. */
function QzoneName({ content }: { content: string }) {
  return (
    <span className="weq-qzn-name">
      {qzoneTextParts(content).map((part) =>
        part.kind === 'emoji' ? (
          <QzoneEmoji key={`${part.offset}:${part.code}`} code={part.code} />
        ) : (
          <span key={`${part.offset}:text`}>{part.text}</span>
        ),
      )}
    </span>
  );
}

function QzoneText({
  content,
  onSpace,
}: {
  content: string;
  onSpace: (uin: string, nickname?: string) => void;
}) {
  return (
    <>
      {qzoneTextParts(content).map((part) =>
        part.kind === 'mention' ? (
          <button
            key={`${part.offset}:${part.uin}`}
            type="button"
            className="weq-qzn-mention"
            title={`QQ ${part.uin}`}
            onClick={() => onSpace(part.uin, part.text.slice(1))}
          >
            <QzoneName content={part.text} />
          </button>
        ) : part.kind === 'emoji' ? (
          <QzoneEmoji key={`${part.offset}:${part.code}`} code={part.code} />
        ) : (
          <span key={`${part.offset}:text`}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** Use the existing cached image bridge; direct CDN URLs are blocked by CSP. */
function QzoneEmoji({ code }: { code: string }) {
  const [sourceIndex, setSourceIndex] = useState(0);
  if (sourceIndex >= 2)
    return (
      <span className="weq-qzn-emoji-unavailable" title={`QQ 表情 ${code}`}>
        [QQ表情]
      </span>
    );
  const extension = sourceIndex === 0 ? 'gif' : 'png';
  return (
    <img
      className="weq-qzn-emoji"
      src={avatarFetchUrl(`https://qzonestyle.gtimg.cn/qzone/em/${code}.${extension}`)}
      alt="[QQ表情]"
      title={`QQ 表情 ${code}`}
      loading="lazy"
      onError={() => setSourceIndex((current) => (current === sourceIndex ? current + 1 : current))}
    />
  );
}

/** Explicit cancellation also reaches main-process CGIs over Electron IPC. */
function useQzoneRequests() {
  const ids = useRef(new Set<string>());
  const cancel = useCallback(() => {
    for (const requestId of ids.current)
      void client.account.qzone.cancel.mutate({ requestId }).catch(() => {});
    ids.current.clear();
  }, []);
  useEffect(() => cancel, [cancel]);
  const run = useCallback(
    async <T,>(work: (requestId: string) => Promise<T>, background = false): Promise<T> => {
      const requestId = crypto.randomUUID();
      ids.current.add(requestId);
      try {
        return await queueQzoneRead(() => {
          if (!ids.current.has(requestId)) throw new Error('空间加载已取消。');
          return work(requestId);
        }, background);
      } finally {
        ids.current.delete(requestId);
      }
    },
    [],
  );
  return { run, cancel };
}

export function QzoneView({
  selfUin,
  nickname,
}: {
  selfUin: string;
  nickname: string;
}): ReactElement {
  const [tab, setTab] = useState<Tab>('feeds');
  const [hostUin, setHostUin] = useState(selfUin);
  const [spaces, setSpaces] = useState<string[]>([]);
  const [spaceNames, setSpaceNames] = useState<Record<string, string>>({});
  const rememberSpaceName = useCallback((uin: string, name: string) => {
    const value = name.trim();
    if (!value || value === uin) return;
    setSpaceNames((current) => (current[uin] === value ? current : { ...current, [uin]: value }));
  }, []);
  const [inputUin, setInputUin] = useState('');
  const [targetError, setTargetError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [compose, setCompose] = useState(false);
  const openSpace = (uin: string, name?: string): void => {
    const value = uin.trim();
    if (!/^[1-9]\d{4,19}$/.test(value)) {
      setTargetError('请输入有效的 QQ 号');
      return;
    }
    setTargetError('');
    if (name) rememberSpaceName(value, name);
    setHostUin(value);
    if (value === selfUin) setTab('posts');
    else {
      setSpaces((current) => (current.includes(value) ? current : [...current, value]));
      setTab('space');
    }
  };
  return (
    <section className="weq-qzn" aria-label="QQ 空间">
      <header className="weq-qzn-header">
        <div className="weq-qzn-identity">
          <QqAvatar uin={selfUin} size={36} />
          <div>
            <strong>QQ 空间</strong>
            <QzoneName content={nickname} />
          </div>
        </div>
        <div className="weq-qzn-tools">
          <button
            type="button"
            title="刷新空间"
            aria-label="刷新空间"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RefreshCw size={17} />
          </button>
          <button type="button" className="weq-qzn-primary" onClick={() => setCompose(true)}>
            <Send size={15} />
            写说说
          </button>
        </div>
      </header>
      <div className="weq-qzn-navigation">
        <nav aria-label="空间栏目">
          <button
            type="button"
            aria-current={tab === 'feeds' ? 'page' : undefined}
            onClick={() => setTab('feeds')}
          >
            好友动态
          </button>
          <button
            type="button"
            aria-current={tab === 'posts' ? 'page' : undefined}
            onClick={() => {
              setHostUin(selfUin);
              setTab('posts');
            }}
          >
            我的说说
          </button>
          <button
            type="button"
            aria-current={tab === 'albums' ? 'page' : undefined}
            onClick={() => setTab('albums')}
          >
            相册
          </button>
          {spaces.map((uin) => (
            <span className="weq-qzn-space-tab" key={uin}>
              <button
                type="button"
                aria-current={tab === 'space' && hostUin === uin ? 'page' : undefined}
                onClick={() => {
                  setHostUin(uin);
                  setTab('space');
                }}
              >
                <QzoneName content={spaceNames[uin] || uin} />
              </button>
              <button
                type="button"
                aria-label={`关闭 ${spaceNames[uin] || uin} 的空间`}
                onClick={() => {
                  setSpaces((current) => current.filter((value) => value !== uin));
                  if (tab === 'space' && hostUin === uin) {
                    setHostUin(selfUin);
                    setTab('feeds');
                  }
                }}
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </nav>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            openSpace(inputUin);
          }}
        >
          <input
            aria-label="好友 QQ 号"
            placeholder="查看好友空间 · QQ 号"
            value={inputUin}
            onChange={(event) => setInputUin(event.target.value)}
            inputMode="numeric"
          />
          <button type="submit">查看</button>
        </form>
      </div>
      {targetError ? (
        <p className="weq-qzn-status" role="alert">
          {targetError}
        </p>
      ) : null}
      <div key={`${tab}:${hostUin}:${refresh}`} className="weq-qzn-scroll">
        {tab === 'feeds' ? (
          <Feeds key={`feeds:${refresh}`} selfUin={selfUin} onSpace={openSpace} />
        ) : null}
        {tab === 'posts' || tab === 'space' ? (
          <Posts
            key={`${hostUin}:${refresh}`}
            selfUin={selfUin}
            hostUin={hostUin}
            nickname={hostUin === selfUin ? nickname : spaceNames[hostUin] || hostUin}
            onSpace={openSpace}
            onOwnerNickname={rememberSpaceName}
          />
        ) : null}
        {tab === 'albums' ? (
          <QzoneAlbumDialog
            key={`${hostUin}:${refresh}`}
            open
            embedded
            hostUin={hostUin}
            onClose={() => setTab(hostUin === selfUin ? 'posts' : 'space')}
          />
        ) : null}
      </div>
      {compose ? (
        <Composer
          selfUin={selfUin}
          onClose={() => setCompose(false)}
          onPublished={() => {
            setCompose(false);
            setHostUin(selfUin);
            setTab('posts');
            setRefresh((value) => value + 1);
          }}
        />
      ) : null}
    </section>
  );
}

function State({
  loading,
  error,
  empty,
  retry,
}: {
  loading: boolean;
  error: string;
  empty: string;
  retry?: () => void;
}) {
  return (
    <div className="weq-qzn-state" role="status">
      {loading ? (
        <>
          <Loader2 size={22} className="weq-spin" />
          正在加载…
        </>
      ) : error ? (
        <>
          <span>{error}</span>
          {retry ? (
            <button type="button" onClick={retry}>
              重试
            </button>
          ) : null}
        </>
      ) : (
        empty
      )}
    </div>
  );
}

function Posts({
  selfUin,
  hostUin,
  nickname,
  onSpace,
  onOwnerNickname,
}: {
  selfUin: string;
  hostUin: string;
  nickname: string;
  onSpace: (uin: string, nickname?: string) => void;
  onOwnerNickname: (uin: string, nickname: string) => void;
}) {
  const [posts, setPosts] = useState<QzoneEmotion[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const moreRef = useRef<HTMLDivElement>(null);
  const nearEnd = useNearViewport(moreRef);
  const nextOffset = useRef(0);
  const currentPosts = useRef<QzoneEmotion[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    void run((requestId) =>
      client.account.qzone.posts.query({ selfUin, hostUin, requestId, offset }),
    )
      .then((page) => {
        if (!live) return;
        setTotal(page.total);
        if (page.nickname) onOwnerNickname(hostUin, page.nickname);
        const merged = mergeQzonePosts(currentPosts.current, page.list);
        setDone(
          !page.list.length ||
            merged.length === currentPosts.current.length ||
            offset + page.list.length >= page.total,
        );
        currentPosts.current = merged;
        nextOffset.current = offset + page.list.length;
        setPosts(merged);
      })
      .catch((error: unknown) => {
        if (live) setError(errorText(error));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      cancel();
    };
  }, [selfUin, hostUin, offset, retry, run, cancel, onOwnerNickname]);
  useEffect(() => {
    if (nearEnd && posts.length > 0 && !loading && !done && !error) setOffset(nextOffset.current);
  }, [nearEnd, posts.length, loading, done, error]);
  return (
    <div className="weq-qzn-timeline">
      <div className="weq-qzn-section-title">
        <h2>
          <QzoneName content={nickname} /> <span className="weq-qzn-space-uin">({hostUin})</span>{' '}
          的空间
        </h2>
        {total > 0 ? (
          <span>
            {posts.length} / {total}
          </span>
        ) : null}
      </div>
      {posts.map((post) => (
        <Post
          key={post.tid}
          selfUin={selfUin}
          hostUin={hostUin}
          nickname={nickname}
          post={post}
          onSpace={onSpace}
        />
      ))}
      {error || (loading && !posts.length) || (!loading && !posts.length) ? (
        <State
          loading={loading}
          error={error}
          empty="这个空间暂无可查看的说说"
          retry={() => setRetry((value) => value + 1)}
        />
      ) : null}
      <div ref={moreRef} className="weq-qzn-page-sentinel">
        {posts.length > 0 && !done && !error ? (
          <button
            type="button"
            className="weq-qzn-more"
            disabled={loading}
            onClick={() => setOffset(nextOffset.current)}
          >
            {loading ? '加载中…' : '加载更多说说'}
          </button>
        ) : null}
        {done && posts.length > 0 ? <p className="weq-qzn-status">已到列表末尾</p> : null}
      </div>
    </div>
  );
}

function Post({
  selfUin,
  hostUin,
  nickname,
  post,
  onSpace,
}: {
  selfUin: string;
  hostUin: string;
  nickname: string;
  post: QzoneEmotion;
  onSpace: (uin: string, nickname?: string) => void;
}) {
  return (
    <article className="weq-qzn-post">
      <div className="weq-qzn-post-head">
        <QqAvatar uin={hostUin} size={34} />
        <div>
          <strong>
            <QzoneName content={nickname} />
          </strong>
          <time dateTime={new Date(post.time * 1000).toISOString()}>
            {timeText(post.time)}
            {post.isPrivate ? ' · 仅自己可见' : ''}
          </time>
        </div>
      </div>
      <p className="weq-qzn-content">
        <QzoneText content={post.content} onSpace={onSpace} />
      </p>
      <Pictures images={post.images} />
      {post.videos.map((video, index) => {
        const src = qzoneMediaSource(video.videoUrl);
        const cover = qzoneMediaSource(video.coverUrl);
        return src ? (
          <button
            type="button"
            className="weq-qzn-video"
            key={video.videoId || `${index}`}
            onClick={() =>
              openVideoLightbox(albumMediaUrl(src), cover ? albumMediaUrl(cover) : undefined)
            }
          >
            {cover ? <img src={albumMediaUrl(cover)} alt="视频封面" loading="lazy" /> : null}
            <span>播放视频</span>
          </button>
        ) : (
          <p className="weq-qzn-status" key={video.videoId || `${index}`}>
            此视频暂时没有可播放地址
          </p>
        );
      })}
      <PostActions selfUin={selfUin} hostUin={hostUin} post={post} onSpace={onSpace} />
    </article>
  );
}

type InteractionPost = Pick<QzoneEmotion, 'tid' | 'time'> & { commentNum: number | null };
function PostActions({
  selfUin,
  hostUin,
  post,
  onSpace,
  initialLikeCount = null,
}: {
  selfUin: string;
  hostUin: string;
  post: InteractionPost;
  onSpace: (uin: string, nickname?: string) => void;
  initialLikeCount?: number | null;
}) {
  const [expanded, setExpanded] = useState<'comments' | 'likes' | null>(null);
  const [likes, setLikes] = useState<QzoneLikesResult | null>(null);
  const [likeError, setLikeError] = useState('');
  const [commentCount, setCommentCount] = useState(post.commentNum);
  const ref = useRef<HTMLDivElement>(null);
  const visible = useNearViewport(ref, true);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    if (!visible) return undefined;
    let live = true;
    void run(
      (requestId) =>
        client.account.qzone.summary.query({
          selfUin,
          hostUin,
          tid: post.tid,
          requestId,
          needCommentCount: post.commentNum === null,
        }),
      true,
    )
      .then((result) => {
        if (live) {
          setLikes(result.likes);
          if (result.commentCount !== null) setCommentCount(result.commentCount);
        }
      })
      .catch((error: unknown) => {
        if (live) setLikeError(errorText(error));
      });
    return () => {
      live = false;
      cancel();
    };
  }, [visible, selfUin, hostUin, post.tid, post.commentNum, run, cancel]);
  const likeCount = likes?.reportedTotal ?? initialLikeCount;
  return (
    <div ref={ref}>
      <div className="weq-qzn-actions">
        <button
          type="button"
          aria-expanded={expanded === 'likes'}
          title={likeError || undefined}
          onClick={() => setExpanded(expanded === 'likes' ? null : 'likes')}
        >
          <ThumbsUp size={16} />赞 {likeCount ?? '—'}
        </button>
        <button
          type="button"
          aria-expanded={expanded === 'comments'}
          onClick={() => setExpanded(expanded === 'comments' ? null : 'comments')}
        >
          <MessageCircle size={16} />
          评论 {commentCount ?? '—'}
        </button>
      </div>
      {expanded ? (
        <Interaction
          key={expanded}
          mode={expanded}
          selfUin={selfUin}
          hostUin={hostUin}
          post={{ ...post, commentNum: commentCount }}
          onSpace={onSpace}
          initialLikes={likes}
          onCommentCount={setCommentCount}
        />
      ) : null}
    </div>
  );
}

function Pictures({ images }: { images: string[] }) {
  const urls = [
    ...new Set(images.map(qzoneMediaSource).filter((url): url is string => Boolean(url))),
  ];
  return urls.length ? (
    <div className="weq-qzn-pictures">
      {urls.map((url, index) => (
        <Picture key={url} url={url} index={index} />
      ))}
    </div>
  ) : null;
}

function Picture({ url, index }: { url: string; index: number }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    <span className="weq-qzn-image-unavailable">图片暂时无法加载</span>
  ) : (
    <button type="button" onClick={() => openLightbox(albumMediaUrl(url), '空间图片')}>
      <img
        src={albumMediaUrl(url)}
        alt={`空间图片 ${index + 1}`}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function Interaction({
  mode,
  selfUin,
  hostUin,
  post,
  onSpace,
  initialLikes,
  onCommentCount,
}: {
  mode: 'comments' | 'likes';
  selfUin: string;
  hostUin: string;
  post: InteractionPost;
  onSpace: (uin: string, nickname?: string) => void;
  initialLikes: QzoneLikesResult | null;
  onCommentCount: (count: number) => void;
}) {
  const [result, setResult] = useState<QzoneInteraction | null>(null);
  const [likes, setLikes] = useState<QzoneLikesResult | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { run, cancel } = useQzoneRequests();
  const readyLikes = mode === 'likes' ? initialLikes : null;
  useEffect(() => {
    let live = true;
    setError('');
    setResult(null);
    setLikes(readyLikes);
    if (readyLikes?.coverage === 'complete') return undefined;
    void run(async (requestId) => {
      const input = { selfUin, hostUin, tid: post.tid, requestId };
      if (mode === 'likes') {
        const page = readyLikes ?? (await client.account.qzone.likes.query(input));
        if (live) setLikes(page);
        if (page.coverage !== 'complete' && post.time > 0) {
          try {
            // Reuse the existing space interaction reader to supplement a
            // truncated roster; never invent a pagination parameter.
            const extra = await client.account.qzone.interactions.query({
              ...input,
              time: post.time,
            });
            const people = new Map(page.likes.map((person) => [person.uin, person]));
            for (const person of extra.likes)
              if (!people.has(person.uin)) people.set(person.uin, person);
            if (live) setLikes({ ...page, likes: [...people.values()] });
          } catch {
            // Keep the successful primary roster when supplementation fails.
          }
        }
      } else {
        const page = await client.account.qzone.interactions.query({ ...input, time: post.time });
        if (live) {
          setResult(page);
          if (page.fieldCoverage?.comments === 'complete')
            onCommentCount(page.comments.filter((comment) => !comment.isReply).length);
        }
      }
    }).catch((error: unknown) => {
      if (live) setError(errorText(error));
    });
    return () => {
      live = false;
      cancel();
    };
  }, [mode, selfUin, hostUin, post.tid, post.time, retry, run, cancel, readyLikes, onCommentCount]);
  if (error || (!result && !likes))
    return (
      <State loading={!error} error={error} empty="" retry={() => setRetry((value) => value + 1)} />
    );
  if (likes)
    return (
      <div className="weq-qzn-interaction">
        <div className="weq-qzn-like-users">
          {likes.likes.map((like) => (
            <button type="button" key={like.uin} onClick={() => onSpace(like.uin, like.nickname)}>
              <QqAvatar uin={like.uin} size={24} />
              <QzoneName content={like.nickname || like.uin} />
            </button>
          ))}
        </div>
        <p className="weq-qzn-status">
          {likes.coverage === 'complete'
            ? likes.likes.length
              ? `${likes.likes.length} 人赞过`
              : '还没有人赞过'
            : `已显示 ${likes.likes.length} 人${likes.reportedTotal === null ? '' : `，共 ${likes.reportedTotal} 人`}`}
        </p>
      </div>
    );
  const roots = result!.comments.filter((comment) => !comment.isReply);
  const replies = result!.comments.filter((comment) => comment.isReply);
  const orphans = replies.filter(
    (reply) => !roots.some((root) => root.id === reply.parentCommentId),
  );
  const renderComment = (comment: QzoneInteraction['comments'][number]) => (
    <div className={`weq-qzn-comment${comment.isReply ? ' is-reply' : ''}`} key={comment.id}>
      <QqAvatar uin={comment.uin} size={26} />
      <div>
        <button
          type="button"
          className="weq-qzn-person"
          onClick={() => onSpace(comment.uin, comment.nickname)}
        >
          <QzoneName content={comment.nickname || comment.uin} />
        </button>
        {comment.replyToNickname ? (
          <span>
            {' '}
            回复{' '}
            {comment.replyToUin ? (
              <button
                type="button"
                className="weq-qzn-person"
                onClick={() => onSpace(comment.replyToUin!, comment.replyToNickname)}
              >
                <QzoneName content={comment.replyToNickname} />
              </button>
            ) : (
              <QzoneName content={comment.replyToNickname} />
            )}
          </span>
        ) : null}
        <p>
          <QzoneText content={comment.content} onSpace={onSpace} />
        </p>
        <Pictures images={comment.images} />
        <time>{timeText(comment.time)}</time>
      </div>
    </div>
  );
  return (
    <div className="weq-qzn-interaction">
      {roots.map((root) => (
        <div key={root.id}>
          {renderComment(root)}
          {replies.filter((reply) => reply.parentCommentId === root.id).map(renderComment)}
        </div>
      ))}
      {orphans.map(renderComment)}
      <p className="weq-qzn-status">
        {result!.fieldCoverage?.comments === 'complete'
          ? roots.length
            ? '评论已加载'
            : '暂无评论'
          : roots.length
            ? `已显示 ${roots.length} 条评论${post.commentNum === null ? '' : `，共 ${post.commentNum} 条`}`
            : '暂未读取到评论'}
        {result!.fieldCoverage?.replies !== 'complete' ? ' · 回复可能未全部展开' : ''}
      </p>
    </div>
  );
}

function Feeds({
  selfUin,
  onSpace,
}: {
  selfUin: string;
  onSpace: (uin: string, nickname?: string) => void;
}) {
  const [feeds, setFeeds] = useState<QzoneFeed[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState(0);
  const [retry, setRetry] = useState(0);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    let live = true;
    setFeeds(null);
    setError('');
    void run((requestId) => client.account.qzone.feeds.query({ selfUin, requestId }))
      .then((page) => {
        if (live) setFeeds(page.feeds);
      })
      .catch((error: unknown) => {
        if (live) setError(errorText(error));
      });
    return () => {
      live = false;
      cancel();
    };
  }, [selfUin, retry, run, cancel]);
  const shown = useMemo(
    () =>
      feeds
        ?.filter((feed) => feed.uin > 0)
        .map((feed) => ({ feed, body: projectQzoneFeed(feed.html) }))
        .filter(
          ({ feed, body }) =>
            !body.advertisement &&
            (!filter ||
              (filter === -1 ? ![311, 2, 4].includes(feed.appid) : feed.appid === filter)),
        ),
    [feeds, filter],
  );
  return (
    <div className="weq-qzn-timeline">
      <div className="weq-qzn-section-title">
        <h2>好友动态</h2>
        <select
          aria-label="动态类型"
          value={filter}
          onChange={(event) => setFilter(Number(event.target.value))}
        >
          <option value={0}>全部动态</option>
          <option value={311}>说说</option>
          <option value={2}>日志</option>
          <option value={4}>相册</option>
          <option value={-1}>其他动态</option>
        </select>
      </div>
      {!feeds || error ? (
        <State
          loading={!error}
          error={error}
          empty=""
          retry={() => setRetry((value) => value + 1)}
        />
      ) : null}
      {shown?.map(({ feed, body }) => {
        const tid = body.tid || (/^[a-f0-9]{6,128}$/i.test(feed.key) ? feed.key : null);
        return (
          <article className="weq-qzn-post" key={`${feed.uin}:${feed.appid}:${feed.key}`}>
            <div className="weq-qzn-post-head">
              <button
                type="button"
                aria-label={`进入 ${feed.nickname || feed.uin} 的空间`}
                onClick={() => onSpace(String(feed.uin), feed.nickname)}
              >
                <QqAvatar uin={String(feed.uin)} size={34} />
              </button>
              <div>
                <button type="button" onClick={() => onSpace(String(feed.uin), feed.nickname)}>
                  <QzoneName content={feed.nickname || String(feed.uin)} />
                </button>
                <time>{timeText(feed.time)}</time>
              </div>
              <span className="weq-qzn-feed-kind">
                {({ 311: '说说', 2: '日志', 4: '相册', 216: '动态' } as Record<number, string>)[
                  feed.appid
                ] || '动态'}
              </span>
            </div>
            <p className="weq-qzn-content">
              <QzoneText content={body.text || '此动态暂时没有可显示的正文'} onSpace={onSpace} />
            </p>
            <Pictures images={body.images} />
            {body.links.map((link) => (
              <a
                className="weq-qzn-feed-link"
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {link.text}
              </a>
            ))}
            {feed.appid === 311 && tid && /^[a-zA-Z0-9_-]{1,128}$/.test(tid) ? (
              <PostActions
                selfUin={selfUin}
                hostUin={String(feed.uin)}
                post={{ tid, time: feed.time, commentNum: body.commentCount }}
                initialLikeCount={body.likeCount}
                onSpace={onSpace}
              />
            ) : feed.appid === 311 ? (
              <div className="weq-qzn-actions">
                <span>赞 {body.likeCount ?? '—'}</span>
                <span>评论 {body.commentCount ?? '—'}</span>
              </div>
            ) : null}
          </article>
        );
      })}
      {feeds && !error ? (
        <p className="weq-qzn-status">
          {shown?.length
            ? '当前为最近一页动态'
            : filter
              ? '最近动态中暂无此类型内容'
              : '暂时没有可查看的动态'}
        </p>
      ) : null}
    </div>
  );
}

function Composer({
  selfUin,
  onClose,
  onPublished,
}: {
  selfUin: string;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [content, setContent] = useState('');
  const [images, setImages] = useState<
    { id: string; base64: string; name: string; type: string }[]
  >([]);
  const [visibility, setVisibility] = useState<1 | 4 | 64>(1);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const active = useRef(true),
    locked = useRef(false);
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  async function choose(files: FileList | null): Promise<void> {
    if (!files || locked.current || reading) return;
    const picked = Array.from(files);
    if (
      picked.length + images.length > 9 ||
      picked.some(
        (file) =>
          file.size > 10 * 1024 * 1024 ||
          !['image/jpeg', 'image/png', 'image/webp'].includes(file.type),
      ) ||
      picked.reduce((n, file) => n + file.size, 0) +
        images.reduce((n, image) => n + image.base64.length * 0.75, 0) >
        30 * 1024 * 1024
    ) {
      setError('最多选择 9 张 JPG、PNG 或 WebP 图片，每张不超过 10 MB，合计不超过 30 MB。');
      return;
    }
    setReading(true);
    setError('');
    try {
      const entries: { id: string; base64: string; name: string; type: string }[] = [];
      for (const file of picked) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1]!);
          reader.onerror = () => reject(new Error('图片读取失败'));
          reader.readAsDataURL(file);
        });
        entries.push({ id: crypto.randomUUID(), base64: data, name: file.name, type: file.type });
      }
      if (active.current) setImages((old) => [...old, ...entries]);
    } catch (error) {
      if (active.current) setError(errorText(error));
    } finally {
      if (active.current) setReading(false);
    }
  }
  async function publish(): Promise<void> {
    if (locked.current || reading || uncertain || !content.trim()) return;
    locked.current = true;
    setBusy(true);
    setError('');
    let submitted = false;
    try {
      const richvals: string[] = [];
      for (const [index, image] of images.entries()) {
        setStage(`上传图片 ${index + 1}/${images.length}`);
        const result = await client.account.qzone.uploadImage.mutate({
          selfUin,
          base64: image.base64,
        });
        richvals.push(result.richval);
      }
      setStage('正在发表');
      submitted = true;
      await client.account.qzone.publish.mutate({ selfUin, content, richvals, visibility });
      if (active.current) onPublished();
    } catch (error) {
      if (active.current) {
        setUncertain(submitted);
        setError(
          submitted
            ? `${errorText(error)} 请先刷新我的说说确认结果，再决定是否重新发表。`
            : errorText(error),
        );
      }
    } finally {
      locked.current = false;
      if (active.current) {
        setBusy(false);
        setStage('');
      }
    }
  }
  return (
    <Modal
      width={600}
      onClose={busy ? undefined : onClose}
      labelledBy="weq-qzn-compose-title"
      className="weq-qzn-compose-modal"
    >
      <section className="weq-qzn-composer">
        <header>
          <h2 id="weq-qzn-compose-title">写说说</h2>
          <button type="button" disabled={busy} onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <textarea
          aria-label="说说内容"
          autoFocus
          placeholder="分享此刻的心情…"
          value={content}
          maxLength={10_000}
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
        />
        <div className="weq-qzn-draft-images">
          {images.map((image, index) => (
            <span key={image.id}>
              <img src={`data:${image.type};base64,${image.base64}`} alt={image.name} />
              <button
                type="button"
                aria-label={`移除图片 ${index + 1}`}
                disabled={busy}
                onClick={() => setImages((old) => old.filter((_, i) => i !== index))}
              >
                <X size={14} />
              </button>
            </span>
          ))}
        </div>
        <footer>
          <label className={`weq-qzn-file${busy || reading ? ' is-disabled' : ''}`}>
            <ImagePlus size={17} />
            图片
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={busy || reading}
              onChange={(event) => {
                void choose(event.target.files);
                event.target.value = '';
              }}
            />
          </label>
          <select
            aria-label="说说可见范围"
            disabled={busy}
            value={visibility}
            onChange={(event) => setVisibility(Number(event.target.value) as 1 | 4 | 64)}
          >
            {QZONE_VISIBILITY.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="weq-qzn-primary"
            disabled={busy || reading || uncertain || !content.trim()}
            onClick={() => void publish()}
          >
            {busy || reading ? <Loader2 size={15} className="weq-spin" /> : <Send size={15} />}
            {stage || (reading ? '读取图片' : '发表')}
          </button>
        </footer>
        {error ? (
          <p role="alert" className="weq-qzn-status">
            {error}
          </p>
        ) : null}
        {uncertain ? (
          <button
            type="button"
            onClick={() => {
              onClose();
            }}
          >
            关闭并确认发表结果
          </button>
        ) : null}
      </section>
    </Modal>
  );
}
