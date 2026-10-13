/** Qzone's known web capabilities, rendered in the local WeQ UI. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { ImagePlus, Loader2, MessageCircle, RefreshCw, Send, ThumbsUp, X } from 'lucide-react';
import { client } from '../trpc/client';
import { QqAvatar } from '../components/QqAvatar';
import { QzoneAlbumDialog } from '../components/QzoneAlbumDialog';
import { openLightbox } from '../components/ImageLightbox';
import { openVideoLightbox } from '../components/VideoLightbox';
import { albumMediaUrl } from '../lib/resourceUrl';
import { projectQzoneFeed, qzoneMediaSource, mergeQzonePosts } from '../lib/qzone';
import { Modal } from '../components/Dialog';
import type { QzoneEmotion, QzoneFeed, QzoneInteraction, QzoneLikesResult } from './qzone_types';
import '../styles/qzone.css';
import { QZONE_VISIBILITY } from '../../../shared/qzone';

type Tab = 'feeds' | 'posts' | 'albums';
const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : '加载失败，请重试。';
function timeText(time: number): string {
  return time ? new Date(time * 1000).toLocaleString('zh-CN', { hour12: false }) : '';
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
  const run = useCallback(async <T,>(work: (requestId: string) => Promise<T>): Promise<T> => {
    const requestId = crypto.randomUUID();
    ids.current.add(requestId);
    try {
      return await work(requestId);
    } finally {
      ids.current.delete(requestId);
    }
  }, []);
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
  const [inputUin, setInputUin] = useState('');
  const [targetError, setTargetError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [compose, setCompose] = useState(false);
  const openSpace = (uin: string): void => {
    const value = uin.trim();
    if (!/^[1-9]\d{4,19}$/.test(value)) {
      setTargetError('请输入有效的 QQ 号');
      return;
    }
    setTargetError('');
    setHostUin(value);
    setTab('posts');
    setRefresh((value) => value + 1);
  };
  return (
    <section className="weq-qzn" aria-label="QQ 空间">
      <header className="weq-qzn-header">
        <div className="weq-qzn-identity">
          <QqAvatar uin={selfUin} size={36} />
          <div>
            <strong>QQ 空间</strong>
            <span>{nickname}</span>
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
      {tab !== 'feeds' && hostUin !== selfUin ? (
        <div className="weq-qzn-target">
          <span>正在查看 {hostUin} 的空间</span>
          <button
            type="button"
            onClick={() => {
              setHostUin(selfUin);
              setTab('posts');
            }}
          >
            回到我的空间
          </button>
        </div>
      ) : null}
      <div key={`${tab}:${hostUin}:${refresh}`} className="weq-qzn-scroll">
        {tab === 'feeds' ? (
          <Feeds key={`feeds:${refresh}`} selfUin={selfUin} onSpace={openSpace} />
        ) : null}
        {tab === 'posts' ? (
          <Posts
            key={`${hostUin}:${refresh}`}
            selfUin={selfUin}
            hostUin={hostUin}
            nickname={hostUin === selfUin ? nickname : hostUin}
          />
        ) : null}
        {tab === 'albums' ? (
          <QzoneAlbumDialog
            key={`${hostUin}:${refresh}`}
            open
            embedded
            hostUin={hostUin}
            onClose={() => setTab('posts')}
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
}: {
  selfUin: string;
  hostUin: string;
  nickname: string;
}) {
  const [posts, setPosts] = useState<QzoneEmotion[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
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
  }, [selfUin, hostUin, offset, retry, run, cancel]);
  return (
    <div className="weq-qzn-timeline">
      <div className="weq-qzn-section-title">
        <h2>{hostUin === selfUin ? '我的说说' : `${hostUin} 的说说`}</h2>
        {total > 0 ? (
          <span>
            {posts.length} / {total}
          </span>
        ) : null}
      </div>
      {posts.map((post) => (
        <Post key={post.tid} selfUin={selfUin} hostUin={hostUin} nickname={nickname} post={post} />
      ))}
      {error || (loading && !posts.length) || (!loading && !posts.length) ? (
        <State
          loading={loading}
          error={error}
          empty="这个空间暂无可查看的说说"
          retry={() => setRetry((value) => value + 1)}
        />
      ) : null}
      {posts.length && !done && !error ? (
        <button
          type="button"
          className="weq-qzn-more"
          disabled={loading}
          onClick={() => setOffset(nextOffset.current)}
        >
          {loading ? '加载中…' : '加载更多说说'}
        </button>
      ) : null}
      {done && posts.length ? <p className="weq-qzn-status">已到列表末尾</p> : null}
    </div>
  );
}

function Post({
  selfUin,
  hostUin,
  nickname,
  post,
}: {
  selfUin: string;
  hostUin: string;
  nickname: string;
  post: QzoneEmotion;
}) {
  const [expanded, setExpanded] = useState<'comments' | 'likes' | null>(null);
  return (
    <article className="weq-qzn-post">
      <div className="weq-qzn-post-head">
        <QqAvatar uin={hostUin} size={34} />
        <div>
          <strong>{nickname}</strong>
          <time dateTime={new Date(post.time * 1000).toISOString()}>
            {timeText(post.time)}
            {post.isPrivate ? ' · 仅自己可见' : ''}
          </time>
        </div>
      </div>
      <p className="weq-qzn-content">{post.content}</p>
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
      <div className="weq-qzn-actions">
        <button
          type="button"
          aria-expanded={expanded === 'likes'}
          onClick={() => setExpanded(expanded === 'likes' ? null : 'likes')}
        >
          <ThumbsUp size={16} />赞
        </button>
        <button
          type="button"
          aria-expanded={expanded === 'comments'}
          onClick={() => setExpanded(expanded === 'comments' ? null : 'comments')}
        >
          <MessageCircle size={16} />
          评论 {post.commentNum || ''}
        </button>
      </div>
      {expanded ? (
        <Interaction
          key={expanded}
          mode={expanded}
          selfUin={selfUin}
          hostUin={hostUin}
          post={post}
        />
      ) : null}
    </article>
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
}: {
  mode: 'comments' | 'likes';
  selfUin: string;
  hostUin: string;
  post: QzoneEmotion;
}) {
  const [result, setResult] = useState<QzoneInteraction | null>(null);
  const [likes, setLikes] = useState<QzoneLikesResult | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const { run, cancel } = useQzoneRequests();
  useEffect(() => {
    let live = true;
    setError('');
    setResult(null);
    setLikes(null);
    void run(async (requestId) => {
      const input = { selfUin, hostUin, tid: post.tid, requestId };
      if (mode === 'likes') {
        const page = await client.account.qzone.likes.query(input);
        if (live) setLikes(page);
      } else {
        const page = await client.account.qzone.interactions.query({ ...input, time: post.time });
        if (live) setResult(page);
      }
    }).catch((error: unknown) => {
      if (live) setError(errorText(error));
    });
    return () => {
      live = false;
      cancel();
    };
  }, [mode, selfUin, hostUin, post.tid, post.time, retry, run, cancel]);
  if (error || (!result && !likes))
    return (
      <State loading={!error} error={error} empty="" retry={() => setRetry((value) => value + 1)} />
    );
  if (likes)
    return (
      <div className="weq-qzn-interaction">
        <div className="weq-qzn-like-users">
          {likes.likes.map((like) => (
            <span key={like.uin}>
              <QqAvatar uin={like.uin} size={24} />
              {like.nickname || like.uin}
            </span>
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
        <strong>{comment.nickname || comment.uin}</strong>
        {comment.replyToNickname ? <span> 回复 {comment.replyToNickname}</span> : null}
        <p>{comment.content}</p>
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
            ? '已显示当前可读取的评论'
            : '暂未读取到评论'}
        {result!.fieldCoverage?.replies !== 'complete' ? ' · 回复可能未全部展开' : ''}
      </p>
    </div>
  );
}

function Feeds({ selfUin, onSpace }: { selfUin: string; onSpace: (uin: string) => void }) {
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
  const shown = feeds?.filter(
    (feed) =>
      !filter || (filter === -1 ? ![311, 2, 4].includes(feed.appid) : feed.appid === filter),
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
      {shown?.map((feed) => {
        const body = projectQzoneFeed(feed.html);
        return (
          <article className="weq-qzn-post" key={`${feed.uin}:${feed.appid}:${feed.key}`}>
            <div className="weq-qzn-post-head">
              <QqAvatar uin={String(feed.uin)} size={34} />
              <div>
                <button type="button" onClick={() => onSpace(String(feed.uin))}>
                  {feed.nickname || feed.uin}
                </button>
                <time>{timeText(feed.time)}</time>
              </div>
              <span className="weq-qzn-feed-kind">
                {({ 311: '说说', 2: '日志', 4: '相册', 216: '动态' } as Record<number, string>)[
                  feed.appid
                ] || '动态'}
              </span>
            </div>
            <p className="weq-qzn-content">{body.text || '此动态暂时没有可显示的正文'}</p>
            <Pictures images={body.images} />
            {feed.appid === 311 ? (
              <button type="button" onClick={() => onSpace(String(feed.uin))}>
                查看说说
              </button>
            ) : null}
            {body.links.map((link) => (
              <a
                className="weq-qzn-feed-link"
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {link.text || '查看详情'}
              </a>
            ))}
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
    <Modal width={600} onClose={busy ? undefined : onClose} labelledBy="weq-qzn-compose-title">
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
