import { useContext, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ImagePlus,
  MessageCircle,
  Reply,
  Send,
  ThumbsUp,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type {
  AnonymousQuestion,
  HistoricalSignature,
  PersonalityLabel,
  ProfileComment,
  ProfileLikeUser,
} from '@weq/protocol';
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { client, trpc } from '../trpc/client';
import { useDialog } from './Dialog';
import { QqAvatar } from './QqAvatar';
import { ProfileAvatar } from './ProfileAvatar';
import { QzoneLikesPopover } from './QzoneLikesPopover';
import { ConversationDirectoryContext } from '../lib/conversationDirectory';
import { chooseBrowserFiles, stageAccountFile } from '../lib/accountFilePicker';
import { profileLikeSummary } from '../lib/profileInteractionPresentation';
import { mergeExtrasPages, nextExtrasCursor } from '../lib/profileExtrasPages';
import '../styles/profile-interactions.css';
import '../styles/qzone-interactions.css';

type Target = QQWriteBinding & { uin: string };
const options = { staleTime: 60_000, retry: false as const, refetchOnWindowFocus: false };
function useNames() {
  const directory = useContext(ConversationDirectoryContext);
  return (uin: string, fallback?: string | null) => {
    const entry = directory?.real?.find(
      (row) => row.type === 'direct' && row.otherUser.identityValue === uin,
    );
    return entry?.type === 'direct' ? entry.otherUser.displayName : fallback || uin;
  };
}
function useOperation(online: boolean) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const running = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    if (!online || running.current) return;
    running.current = true;
    setPending(true);
    setError('');
    try {
      await action();
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return { pending, error, run, mounted };
}
export function ProfileLikeSummary({
  users,
  total,
}: {
  users: ProfileLikeUser[];
  total?: string | null;
}) {
  const name = useNames();
  const summary = profileLikeSummary(
    users.map((user) => name(user.uin, user.name)),
    total,
  );
  return summary ? <p className="weq-profile-like-summary">{summary}</p> : null;
}
export function ProfileLabelLikes({
  users,
  total,
}: {
  users: ProfileLikeUser[];
  total?: string | null;
}) {
  const name = useNames();
  if (!users.length && (total === null || total === undefined)) return null;
  return (
    <div className="weq-profile-label-likes weq-qzn-like-users" aria-label="标签点赞列表">
      {users.map((user) => {
        const displayName = name(user.uin, user.name);
        return (
          <span key={user.id} title={`${displayName} (${user.uin})`}>
            <ProfileAvatar target={{ identity: user.uin, name: displayName }}>
              <QqAvatar uin={user.uin} size={20} />
              <span className="weq-profile-label-like-name">{displayName}</span>
            </ProfileAvatar>
          </span>
        );
      })}
      <span className="weq-profile-label-like-total">
        {total === null || total === undefined
          ? '等人点赞'
          : `${users.length ? '等 ' : ''}${total} 人点赞`}
      </span>
    </div>
  );
}
function CommentRows({
  items,
  reply,
  remove,
  canRemove,
  qzone = false,
}: {
  items: ProfileComment[];
  reply?: (item: ProfileComment) => void;
  remove?: (item: ProfileComment) => void;
  canRemove?: (item: ProfileComment) => boolean;
  qzone?: boolean;
}) {
  const name = useNames();
  return (
    <ul className={qzone ? 'weq-signature-comments' : 'weq-profile-comments'}>
      {items.map((item) => {
        const tools =
          qzone || reply || remove ? (
            <div className={qzone ? 'weq-qzn-comment-meta' : 'weq-profile-comment-tools'}>
              {qzone && item.time ? (
                <time>
                  {new Date(item.time * 1000).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                </time>
              ) : null}
              {reply ? (
                <button
                  type="button"
                  title="回复评论"
                  aria-label="回复评论"
                  onClick={() => reply(item)}
                >
                  <Reply size={14} />
                </button>
              ) : null}
              {remove && canRemove?.(item) ? (
                <button
                  type="button"
                  title="删除评论"
                  aria-label={`删除评论：${item.text}`}
                  onClick={() => remove(item)}
                >
                  <Trash2 size={14} />
                </button>
              ) : null}
            </div>
          ) : null;
        return (
          <li
            key={item.id}
            className={qzone ? `weq-qzn-comment${item.replyId ? ' is-reply' : ''}` : undefined}
          >
            <div>
              <ProfileAvatar
                className="weq-identity-link"
                target={{ identity: item.fromUin, name: name(item.fromUin, item.fromName) }}
              >
                {qzone ? <QqAvatar uin={item.fromUin} size={26} /> : null}
                <strong className={qzone ? 'weq-qzn-person' : undefined}>
                  {name(item.fromUin, item.fromName)}
                </strong>
              </ProfileAvatar>
              {item.replyId && item.toUin ? (
                <>
                  {' '}
                  回复{' '}
                  <strong className={qzone ? 'weq-qzn-person' : undefined}>
                    {name(item.toUin, item.toName)}
                  </strong>
                </>
              ) : null}
              {qzone ? <p>{item.text}</p> : <span>：{item.text}</span>}
              {qzone ? tools : null}
            </div>
            {!qzone ? tools : null}
          </li>
        );
      })}
    </ul>
  );
}
export function SignatureInteractions({
  input,
  item,
  online,
  refresh,
}: {
  input: Target;
  item: HistoricalSignature;
  online: boolean;
  refresh: () => Promise<unknown>;
}) {
  const op = useOperation(online);
  const confirm = useDialog((state) => state.confirm);
  const name = useNames();
  const [expanded, setExpanded] = useState(false),
    [showLikes, setShowLikes] = useState(false);
  const [content, setContent] = useState(''),
    [reply, setReply] = useState<ProfileComment | null>(null);
  const [likedOverride, setLiked] = useState<boolean | null>(null);
  const [added, setAdded] = useState<ProfileComment[]>([]),
    [removed, setRemoved] = useState<string[]>([]);
  const args = { ...input, id: item.id, createdAt: item.createdAt };
  const likes = trpc.account.profileExtras.signatureLikes.useInfiniteQuery(args, {
    ...options,
    enabled: online && showLikes,
    getNextPageParam: nextExtrasCursor,
  });
  const likeUsers = likes.data ? mergeExtrasPages(likes.data.pages) : (item.likeUsers ?? []);
  const liked = likedOverride ?? likeUsers.some((user) => user.uin === input.expectedAccountUin);
  const comments = [
    ...new Map([...(item.commentItems ?? []), ...added].map((row) => [row.id, row])).values(),
  ].filter((row) => !removed.includes(row.id));
  async function reload() {
    try {
      await refresh();
      if (showLikes) await likes.refetch();
    } catch {
      /* 写入已完成，保留当前互动，列表可独立刷新。 */
    }
  }
  return (
    <div className="weq-signature-interactions">
      <div className="weq-qzn-actions">
        <QzoneLikesPopover
          trigger={
            <button
              type="button"
              aria-label={liked ? '取消签名点赞' : '点赞签名'}
              title={liked ? '取消签名点赞' : '点赞签名'}
              aria-pressed={liked}
              onMouseEnter={() => setShowLikes(true)}
              onFocus={() => setShowLikes(true)}
              disabled={!online || op.pending}
              onClick={() =>
                void op.run(async () => {
                  await client.account.qqActions.signatureLike.mutate({ ...args, liked: !liked });
                  if (op.mounted.current) setLiked(!liked);
                  await reload();
                })
              }
            >
              <ThumbsUp size={16} fill={liked ? 'currentColor' : 'none'} />赞 {item.likes ?? '?'}
            </button>
          }
        >
          <div className="weq-qzn-interaction">
            <div className="weq-qzn-like-users">
              {likeUsers.map((user) => (
                <span key={user.id}>
                  <ProfileAvatar
                    className="weq-identity-link"
                    target={{ identity: user.uin, name: name(user.uin, user.name) }}
                  >
                    <QqAvatar uin={user.uin} size={20} />
                    <span>{name(user.uin, user.name)}</span>
                  </ProfileAvatar>
                </span>
              ))}
            </div>
            <ProfileLikeSummary users={likeUsers} total={item.likes} />
            {likes.isFetching ? (
              <p className="weq-profile-like-summary" role="status">
                读取中…
              </p>
            ) : null}
            {likes.error ? (
              <button type="button" onClick={() => void likes.refetch()}>
                重试读取点赞人
              </button>
            ) : null}
            {likes.hasNextPage && !likes.error ? (
              <button
                type="button"
                disabled={likes.isFetching}
                onClick={() => void likes.fetchNextPage()}
              >
                <ArrowDown size={14} />
                加载更多
              </button>
            ) : null}
          </div>
        </QzoneLikesPopover>
        <button
          type="button"
          title="评论"
          aria-label="评论"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <MessageCircle size={16} />
          评论
        </button>
      </div>
      {expanded ? (
        <div className="weq-qzn-interaction">
          <CommentRows
            qzone
            items={comments}
            reply={online && !op.pending ? setReply : undefined}
            canRemove={(comment) =>
              comment.fromUin === input.expectedAccountUin || input.uin === input.expectedAccountUin
            }
            remove={
              online && !op.pending
                ? (comment) =>
                    void op.run(async () => {
                      if (!(await confirm('删除评论', `删除“${comment.text}”？`))) return;
                      await client.account.qqActions.deleteSignatureComment.mutate({
                        ...args,
                        commentId: comment.id,
                      });
                      if (op.mounted.current) {
                        setRemoved((rows) => [...rows, comment.id]);
                        if (reply?.id === comment.id) setReply(null);
                      }
                      await reload();
                    })
                : undefined
            }
          />
          {reply ? (
            <div className="weq-profile-reply-target">
              回复 {name(reply.fromUin, reply.fromName)}
              <button
                type="button"
                title="取消回复"
                aria-label="取消回复"
                onClick={() => setReply(null)}
              >
                <X size={14} />
              </button>
            </div>
          ) : null}
          <form
            className="weq-profile-comment-form weq-qzn-comment-composer"
            onSubmit={(event) => {
              event.preventDefault();
              const text = content.trim();
              if (text)
                void op.run(async () => {
                  const result = await client.account.qqActions.signatureComment.mutate({
                    ...input,
                    id: item.id,
                    text,
                    replyId: reply?.id,
                  });
                  if (op.mounted.current) {
                    if (result.commentId)
                      setAdded((rows) => [
                        ...rows,
                        {
                          id: result.commentId!,
                          text,
                          fromUin: input.expectedAccountUin,
                          fromName: '我',
                          toUin: reply?.fromUin ?? null,
                          toName: reply?.fromName ?? null,
                          replyId: reply?.id ?? null,
                          time: Math.floor(Date.now() / 1000),
                        },
                      ]);
                    setContent('');
                    setReply(null);
                  }
                  await reload();
                });
            }}
          >
            <textarea
              aria-label="签名评论"
              placeholder="写评论"
              maxLength={4096}
              rows={2}
              value={content}
              disabled={!online || op.pending}
              onChange={(event) => setContent(event.target.value)}
            />
            <button
              type="submit"
              className="weq-set-iconbtn"
              title="发送评论"
              aria-label="发送评论"
              disabled={!online || op.pending || !content.trim()}
            >
              <Send size={16} />
            </button>
          </form>
        </div>
      ) : null}
      {op.error ? <p role="status">{op.error}</p> : null}
    </div>
  );
}
export function QuestionInteractions({
  input,
  item,
  online,
}: {
  input: Target;
  item: AnonymousQuestion;
  online: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = [
    item.likes === null ? null : `赞 ${item.likes}`,
    item.comments === null ? null : `评论 ${item.comments}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="weq-profile-interactions">
      <button
        type="button"
        className="weq-profile-question-open"
        aria-label="查看问答互动"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <MessageCircle size={15} />
        {counts || '查看互动'}
      </button>
      {expanded ? <QuestionDetail input={input} item={item} online={online} /> : null}
    </div>
  );
}
function QuestionDetail({
  input,
  item,
  online,
}: {
  input: Target;
  item: AnonymousQuestion;
  online: boolean;
}) {
  const detail = trpc.account.profileExtras.anonymousDetail.useQuery(
    { ...input, questionId: item.id, askedAt: item.askedAt ?? 0 },
    { ...options, enabled: online },
  );
  const first = detail.data;
  const more = trpc.account.profileExtras.anonymousComments.useInfiniteQuery(
    { ...input, questionId: item.id },
    {
      ...options,
      enabled: online && Boolean(first?.hasMore && first.nextCursor),
      initialCursor: first?.nextCursor ?? undefined,
      getNextPageParam: nextExtrasCursor,
    },
  );
  const items = mergeExtrasPages([...(first ? [first] : []), ...(more.data?.pages ?? [])]);
  return (
    <>
      {first ? <ProfileLikeSummary users={first.likeUsers} total={first.likes} /> : null}
      <CommentRows items={items} />
      {detail.isFetching || more.isFetching ? <p role="status">读取中…</p> : null}
      {detail.error ? (
        <button type="button" onClick={() => void detail.refetch()}>
          重试读取评论
        </button>
      ) : null}
      {more.error || more.hasNextPage ? (
        <button
          type="button"
          disabled={more.isFetching}
          onClick={() =>
            void (more.error
              ? more.refetch({ refetchPage: (_page, index, pages) => index === pages.length - 1 })
              : more.fetchNextPage())
          }
        >
          <ArrowDown size={14} />
          {more.error ? '重试本页' : '加载更多评论'}
        </button>
      ) : null}
    </>
  );
}
type UploadItem = {
  key: string;
  file: File;
  state: 'ready' | 'uploading' | 'failed' | 'done';
  message: string;
  photoId?: string;
};
export function PersonalityPhotoUploader({
  input,
  label,
  online,
  refresh,
}: {
  input: Target;
  label: PersonalityLabel;
  online: boolean;
  refresh: () => Promise<unknown>;
}) {
  const op = useOperation(online);
  const [files, setFiles] = useState<UploadItem[]>([]);
  useEffect(() => {
    const observed = new Set(label.photos.map((photo) => photo.id));
    setFiles((rows) => {
      let changed = false;
      const next = rows.map((row) => {
        if (
          row.state !== 'done' ||
          !row.photoId ||
          !observed.has(row.photoId) ||
          row.message === '已上传'
        )
          return row;
        changed = true;
        return { ...row, message: '已上传' };
      });
      return changed ? next : rows;
    });
  }, [label.photos]);
  function update(key: string, patch: Partial<UploadItem>) {
    if (op.mounted.current)
      setFiles((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }
  async function upload() {
    const selected = files.filter((row) => row.state === 'ready' || row.state === 'failed');
    const timestamp = Math.floor(Date.now() / 1000);
    for (const [index, row] of selected.entries()) {
      if (!op.mounted.current) break;
      update(row.key, { state: 'uploading', message: '上传中…' });
      let uploadId: string | undefined;
      try {
        const staged = await stageAccountFile(row.file, input);
        uploadId = staged.uploadId;
        if (!op.mounted.current) break;
        const result = await client.account.qqActions.personalityPhotoUpload.mutate({
          ...input,
          labelId: label.id,
          imagePath: staged.path,
          count: selected.length,
          index,
          timestamp,
        });
        update(row.key, {
          state: 'done',
          photoId: result.photoId,
          message: result.observed ? '已上传' : '已上传，等待相册更新',
        });
      } catch (error) {
        update(row.key, {
          state: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (uploadId)
          await client.account.pickedFileDiscard.mutate({ ...input, uploadId }).catch(() => {});
      }
    }
    if (op.mounted.current) {
      try {
        await refresh();
      } catch {
        /* 已上传条目保持完成状态。 */
      }
    }
  }
  return (
    <div className="weq-profile-photo-upload">
      <div className="weq-profile-interaction-bar">
        <button
          type="button"
          disabled={!online || op.pending}
          onClick={() =>
            void op.run(async () => {
              const selected = await chooseBrowserFiles('image/*');
              if (!selected.length || !op.mounted.current) return;
              if (
                selected.length + files.length > 100 ||
                selected.some((file) => !file.size || file.size > 20 * 1024 * 1024)
              )
                throw new Error('请选择最多 100 张、每张 20 MB 以内的图片');
              setFiles((rows) => [
                ...rows,
                ...selected.map((file) => ({
                  key: crypto.randomUUID(),
                  file,
                  state: 'ready' as const,
                  message: '',
                })),
              ]);
            })
          }
        >
          <ImagePlus size={16} />
          添加照片
        </button>
        {files.some((row) => row.state === 'ready' || row.state === 'failed') ? (
          <button
            type="button"
            disabled={!online || op.pending}
            onClick={() => void op.run(upload)}
          >
            <Upload size={16} />
            {files.some((row) => row.state === 'failed') ? '上传待完成照片' : '上传'}
          </button>
        ) : null}
      </div>
      <ul className="weq-profile-upload-list">
        {files.map((row) => (
          <li key={row.key}>
            <span>{row.file.name}</span>
            <small role="status">{row.message}</small>
            {row.state === 'ready' || row.state === 'failed' ? (
              <button
                type="button"
                disabled={op.pending}
                title="移除照片"
                aria-label={`移除 ${row.file.name}`}
                onClick={() => setFiles((rows) => rows.filter((item) => item.key !== row.key))}
              >
                <X size={14} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {files.some((row) => row.state === 'done') ? (
        <button
          type="button"
          disabled={op.pending}
          onClick={() =>
            void op.run(async () => {
              await refresh();
            })
          }
        >
          刷新相册
        </button>
      ) : null}
      {op.error ? <p role="status">{op.error}</p> : null}
    </div>
  );
}
