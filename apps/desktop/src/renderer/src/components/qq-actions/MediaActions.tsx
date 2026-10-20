import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, ThumbsUp, Trash2 } from 'lucide-react';
import type { QQWriteBinding, QQWriteOutcome } from '../../hooks/useQQWriteSession';
import { client } from '../../trpc/client';
import { localFileUrl } from '../../lib/resourceUrl';
import {
  ActionFeedback,
  ActionIcon,
  ImageAction,
  SaveAction,
  useQQAction,
  withQQAccountScope,
} from './shared';

export interface QzoneLikeChange {
  previous: boolean | null;
  next: boolean;
  pending: boolean;
}

function LikeAction({
  action,
  label,
  initialLiked = null,
  disabled,
  submit,
  onChanged,
  optimistic = false,
  onLikeChange,
  likeRevision = 0,
}: {
  action: ReturnType<typeof useQQAction>;
  label: '媒体' | '说说';
  initialLiked?: boolean | null;
  disabled?: boolean;
  submit: (binding: QQWriteBinding, enabled: boolean) => Promise<QQWriteOutcome>;
  onChanged?: () => void;
  optimistic?: boolean;
  onLikeChange?: (change: QzoneLikeChange | null) => void;
  likeRevision?: number;
}) {
  const [liked, setLiked] = useState(initialLiked);
  const [pending, setPending] = useState(false);
  const running = useRef(false);
  const mounted = useRef(true);
  const calibrated = useRef({ initialLiked, likeRevision });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (running.current) return;
    if (
      calibrated.current.initialLiked !== initialLiked ||
      calibrated.current.likeRevision !== likeRevision
    ) {
      if (initialLiked !== null) setLiked(initialLiked);
      calibrated.current = { initialLiked, likeRevision };
    }
  }, [initialLiked, likeRevision, pending]);
  const actionLabel = liked ? `取消${label}点赞` : `点赞${label}`;
  async function toggle() {
    if (running.current || action.disabled || disabled) return;
    running.current = true;
    setPending(true);
    const previous = liked;
    const next = liked !== true;
    if (optimistic) {
      setLiked(next);
      onLikeChange?.({ previous, next, pending: true });
    }
    let accepted = false;
    let settled = false;
    try {
      await action.perform(
        async (binding) => {
          const result = await submit(binding, next);
          accepted = result.state === 'accepted' || result.state === 'confirmed';
          return result;
        },
        async () => {
          if (!mounted.current) return;
          settled = true;
          setLiked(accepted ? next : previous);
          if (optimistic) onLikeChange?.(accepted ? { previous, next, pending: false } : null);
          onChanged?.();
        },
      );
    } finally {
      running.current = false;
      if (mounted.current) {
        if (optimistic && !accepted && !settled) {
          setLiked(previous);
          onLikeChange?.(null);
        }
        setPending(false);
      }
    }
  }
  return (
    <button
      type="button"
      className="weq-set-iconbtn weq-qq-like-toggle"
      aria-label={actionLabel}
      aria-pressed={liked === null ? 'mixed' : liked}
      aria-busy={pending}
      title={pending ? `正在${actionLabel}…` : actionLabel}
      disabled={action.disabled || disabled || pending}
      onClick={() => void toggle()}
    >
      {pending ? (
        <Loader2 size={16} className="weq-qq-like-spin" />
      ) : (
        <ThumbsUp size={16} fill={liked ? 'currentColor' : 'none'} />
      )}
    </button>
  );
}

function GroupAlbumUploadBody({
  groupId,
  albumId,
  albumName,
  onChanged,
}: {
  groupId: number;
  albumId: string;
  albumName: string;
  onChanged: () => void;
}) {
  const a = useQQAction(`album-upload:${groupId}:${albumId}`);
  const [picture, setPicture] = useState<{ path: string; fileName: string } | null>(null);
  return (
    <div className="weq-qq-actions">
      <div className="weq-qq-action-bar">
        <ImageAction
          disabled={a.disabled}
          onClick={() =>
            void a.pickImage().then((f) => {
              if (f) setPicture(f);
            })
          }
        />
        <span>{picture?.fileName}</span>
        <SaveAction
          label="上传到群相册"
          disabled={a.disabled || !picture}
          onClick={() => {
            if (picture)
              void a.perform(
                (b) =>
                  client.account.qqActions.albumUpload.mutate({
                    ...b,
                    groupId,
                    albumId,
                    albumName,
                    path: picture.path,
                  }),
                async () => {
                  setPicture(null);
                  onChanged();
                },
                `将图片上传到群相册「${albumName}」？`,
              );
          }}
        />
      </div>
      <ActionFeedback action={a} />
    </div>
  );
}
function GroupAlbumMediaActionsBody({
  groupId,
  albumId,
  mediaId,
  deleteMediaId,
  batchId,
  uploaderUin,
  uploadTime,
  onChanged,
}: {
  groupId: number;
  albumId: string;
  mediaId: string;
  deleteMediaId?: string;
  batchId: string;
  uploaderUin: string;
  uploadTime: number;
  onChanged: () => void;
}) {
  const a = useQQAction(`album-media:${groupId}:${albumId}:${mediaId}`),
    [comment, setComment] = useState('');
  const base = { groupId, albumId, mediaId, batchId };
  const likeReady =
    /^\d+$/.test(uploaderUin) && Number.isSafeInteger(uploadTime) && uploadTime >= 0;
  const deletionId = deleteMediaId === undefined ? mediaId : deleteMediaId;
  return (
    <div className="weq-qq-media-actions">
      <div className="weq-qq-action-bar">
        <LikeAction
          key={mediaId}
          action={a}
          label="媒体"
          disabled={!likeReady}
          submit={(b, enabled) =>
            client.account.qqActions.albumMedia.mutate({
              ...b,
              ...base,
              uploaderUin,
              uploadTime,
              action: enabled ? 'like' : 'unlike',
            })
          }
        />
        <ActionIcon
          label="删除相册媒体"
          disabled={a.disabled || !deletionId}
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.albumMedia.mutate({
                  ...b,
                  ...base,
                  mediaId: deletionId,
                  action: 'delete',
                }),
              async () => onChanged(),
              '从 QQ 群相册删除这项媒体？不能撤销。',
            )
          }
        >
          <Trash2 size={14} />
        </ActionIcon>
      </div>
      <div className="weq-qq-action-bar">
        <input
          aria-label="媒体评论"
          placeholder="评论"
          value={comment}
          maxLength={4096}
          onChange={(e) => setComment(e.target.value)}
        />
        <SaveAction
          label="发送媒体评论"
          disabled={a.disabled || !comment.trim()}
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.albumMedia.mutate({
                  ...b,
                  ...base,
                  action: 'comment',
                  content: comment,
                }),
              async () => setComment(''),
            )
          }
        />
      </div>
      <ActionFeedback action={a} />
    </div>
  );
}
function QzoneWriteActionsBody({
  hostUin,
  tid,
  time,
  initialLiked,
  onChanged,
  onLikeChange,
  likeRevision,
  onCommentAccepted,
}: {
  hostUin: string;
  tid: string;
  time: number;
  initialLiked?: boolean | null;
  onChanged: () => void;
  onLikeChange?: (change: QzoneLikeChange | null) => void;
  likeRevision?: number;
  onCommentAccepted?: () => void;
}) {
  const a = useQQAction(`qzone:${hostUin}:${tid}`),
    [content, setContent] = useState('');
  const draftRevision = useRef(0);
  const [picture, setPicture] = useState<{ path: string; fileName: string } | null>(null);
  const [commentPending, setCommentPending] = useState(false);
  const commentRunning = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function sendComment() {
    if (commentRunning.current || a.disabled || !content.trim()) return;
    commentRunning.current = true;
    setCommentPending(true);
    const submittedContent = content;
    const submittedPicture = picture;
    const submittedRevision = draftRevision.current;
    let accepted = false;
    try {
      await a.perform(
        async (b) => {
          const result = await client.account.qqActions.qzone.mutate({
            ...b,
            hostUin,
            tid,
            time,
            action: 'comment',
            content: submittedContent,
            imagePath: submittedPicture?.path,
          });
          accepted = result.state === 'accepted' || result.state === 'confirmed';
          return result;
        },
        async () => {
          if (!mounted.current) return;
          if (accepted) {
            if (draftRevision.current === submittedRevision) {
              setContent('');
              setPicture(null);
            }
            onCommentAccepted?.();
          }
          onChanged();
        },
      );
    } finally {
      commentRunning.current = false;
      if (mounted.current) setCommentPending(false);
    }
  }
  return (
    <div className="weq-qq-actions">
      {picture && (
        <div className="weq-qq-action-image">
          <img src={localFileUrl(picture.path)} alt={picture.fileName} />
          <ActionIcon
            label="移除评论图片"
            onClick={() => {
              draftRevision.current++;
              setPicture(null);
            }}
          >
            <Trash2 size={15} />
          </ActionIcon>
        </div>
      )}
      <div className="weq-qq-action-bar" aria-busy={commentPending || undefined}>
        <LikeAction
          key={`${hostUin}:${tid}`}
          action={a}
          label="说说"
          initialLiked={initialLiked}
          optimistic
          onLikeChange={onLikeChange}
          likeRevision={likeRevision}
          onChanged={onChanged}
          submit={(b, enabled) =>
            client.account.qqActions.qzone.mutate({
              ...b,
              hostUin,
              tid,
              time,
              action: enabled ? 'like' : 'unlike',
            })
          }
        />
        <input
          aria-label="说说评论"
          placeholder="写评论"
          value={content}
          maxLength={4096}
          onChange={(e) => {
            draftRevision.current++;
            setContent(e.target.value);
          }}
        />
        <ImageAction
          disabled={a.disabled}
          onClick={() =>
            void a.pickImage().then((f) => {
              if (f) {
                draftRevision.current++;
                setPicture(f);
              }
            })
          }
        />
        <ActionIcon
          label="发送说说评论"
          disabled={a.disabled || commentPending || !content.trim()}
          onClick={() => void sendComment()}
        >
          {commentPending ? (
            <Loader2 size={16} className="weq-qq-like-spin" aria-label="正在发送评论" />
          ) : (
            <Send size={16} />
          )}
        </ActionIcon>
      </div>
      <ActionFeedback action={a} />
    </div>
  );
}
export const GroupAlbumUpload = withQQAccountScope(GroupAlbumUploadBody);
export const GroupAlbumMediaActions = withQQAccountScope(GroupAlbumMediaActionsBody);
export const QzoneWriteActions = withQQAccountScope(QzoneWriteActionsBody);
