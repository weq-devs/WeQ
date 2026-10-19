import { useState } from 'react';
import { ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
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
  batchId,
  uploaderUin,
  uploadTime,
  onChanged,
}: {
  groupId: number;
  albumId: string;
  mediaId: string;
  batchId: string;
  uploaderUin: string;
  uploadTime: number;
  onChanged: () => void;
}) {
  const a = useQQAction(`album-media:${groupId}:${albumId}:${mediaId}`),
    [comment, setComment] = useState('');
  const base = { groupId, albumId, mediaId, batchId, uploaderUin, uploadTime };
  return (
    <div className="weq-qq-media-actions">
      <div className="weq-qq-action-bar">
        <ActionIcon
          label="点赞图片"
          disabled={a.disabled}
          onClick={() =>
            void a.perform((b) =>
              client.account.qqActions.albumMedia.mutate({ ...b, ...base, action: 'like' }),
            )
          }
        >
          <ThumbsUp size={14} />
        </ActionIcon>
        <ActionIcon
          label="取消图片点赞"
          disabled={a.disabled}
          onClick={() =>
            void a.perform((b) =>
              client.account.qqActions.albumMedia.mutate({ ...b, ...base, action: 'unlike' }),
            )
          }
        >
          <ThumbsDown size={14} />
        </ActionIcon>
        <ActionIcon
          label="删除相册媒体"
          disabled={a.disabled}
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.albumMedia.mutate({ ...b, ...base, action: 'delete' }),
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
          aria-label="图片评论"
          placeholder="评论"
          value={comment}
          maxLength={4096}
          onChange={(e) => setComment(e.target.value)}
        />
        <SaveAction
          label="发送图片评论"
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
  onChanged,
}: {
  hostUin: string;
  tid: string;
  time: number;
  onChanged: () => void;
}) {
  const a = useQQAction(`qzone:${hostUin}:${tid}`),
    [content, setContent] = useState('');
  const [picture, setPicture] = useState<{ path: string; fileName: string } | null>(null);
  return (
    <div className="weq-qq-actions">
      {picture && (
        <div className="weq-qq-action-image">
          <img src={localFileUrl(picture.path)} alt={picture.fileName} />
          <ActionIcon label="移除评论图片" onClick={() => setPicture(null)}>
            <Trash2 size={15} />
          </ActionIcon>
        </div>
      )}
      <div className="weq-qq-action-bar">
        <ActionIcon
          label="点赞说说"
          disabled={a.disabled}
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.qzone.mutate({ ...b, hostUin, tid, time, action: 'like' }),
              async () => onChanged(),
            )
          }
        >
          <ThumbsUp size={16} />
        </ActionIcon>
        <ActionIcon
          label="取消说说点赞"
          disabled={a.disabled}
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.qzone.mutate({
                  ...b,
                  hostUin,
                  tid,
                  time,
                  action: 'unlike',
                }),
              async () => onChanged(),
            )
          }
        >
          <ThumbsDown size={16} />
        </ActionIcon>
        <input
          aria-label="说说评论"
          placeholder="写评论"
          value={content}
          maxLength={4096}
          onChange={(e) => setContent(e.target.value)}
        />
        <ImageAction
          disabled={a.disabled}
          onClick={() =>
            void a.pickImage().then((f) => {
              if (f) setPicture(f);
            })
          }
        />
        <SaveAction
          label="发送说说评论"
          disabled={a.disabled || !content.trim()}
          onClick={() =>
            void a.perform(
              (b) =>
                client.account.qqActions.qzone.mutate({
                  ...b,
                  hostUin,
                  tid,
                  time,
                  action: 'comment',
                  content,
                  imagePath: picture?.path,
                }),
              async () => {
                setContent('');
                setPicture(null);
                onChanged();
              },
            )
          }
        />
      </div>
      <ActionFeedback action={a} />
    </div>
  );
}
export const GroupAlbumUpload = withQQAccountScope(GroupAlbumUploadBody);
export const GroupAlbumMediaActions = withQQAccountScope(GroupAlbumMediaActionsBody);
export const QzoneWriteActions = withQQAccountScope(QzoneWriteActionsBody);
