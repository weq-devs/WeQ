import { useEffect, useRef, useState } from 'react';
import { Film, Upload, X } from 'lucide-react';
import { client } from '../../trpc/client';
import { mediaUrl } from '../../lib/resourceUrl';
import { ActionIcon, useQQAction, withQQAccountScope } from './shared';

interface VideoDraft {
  fileName: string;
  file?: File;
  path?: string;
  coverBase64: string;
  durationMs: number;
  width: number;
  height: number;
}
async function prepareVideo(source: string, fileName: string): Promise<VideoDraft> {
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        video.onloadeddata = null;
        video.onerror = null;
        reject(new Error('视频读取超时'));
      }, 15000);
      video.onloadeddata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error('无法读取此视频，请选择可播放的 MP4'));
      };
      video.src = source;
    });
    if (
      !Number.isFinite(video.duration) ||
      video.duration <= 0 ||
      !video.videoWidth ||
      !video.videoHeight
    )
      throw new Error('视频时长或尺寸无法读取');
    const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale)),
      height = Math.max(1, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法生成视频封面');
    context.drawImage(video, 0, 0, width, height);
    const coverBase64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
    if (!coverBase64) throw new Error('视频封面生成失败');
    return {
      fileName,
      coverBase64,
      durationMs: Math.round(video.duration * 1000),
      width,
      height,
    };
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
}
function GroupAlbumVideoUploadBody({
  groupId,
  albumId,
  onChanged,
}: {
  groupId: number;
  albumId: string;
  onChanged: () => void;
}) {
  const a = useQQAction(`album-video:${groupId}:${albumId}`);
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<VideoDraft | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  return (
    <div className="weq-qq-actions">
      <div className="weq-qq-action-bar">
        <ActionIcon
          label="选择视频"
          disabled={a.disabled || preparing}
          onClick={() => {
            if (import.meta.env.VITE_WEQ_TARGET === 'web') {
              fileInput.current?.click();
              return;
            }
            const captured = ++generation.current;
            setPreparing(true);
            setError('');
            setDraft(null);
            void client.account.pickSendFile
              .mutate({ kind: 'video' })
              .then(async (picked) => {
                if (!picked || captured !== generation.current) return;
                const value = await prepareVideo(
                  mediaUrl('localfile', { path: picked.path }),
                  picked.fileName,
                );
                if (captured === generation.current) {
                  setDraft({ ...value, path: picked.path });
                  setSubmitted(false);
                }
              })
              .catch((cause: unknown) => {
                if (captured === generation.current)
                  setError(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => {
                if (captured === generation.current) setPreparing(false);
              });
          }}
        >
          <Film size={16} />
        </ActionIcon>
        <input
          ref={fileInput}
          type="file"
          accept="video/mp4,.mp4"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            const captured = ++generation.current;
            setPreparing(true);
            setError('');
            setDraft(null);
            const source = URL.createObjectURL(file);
            void prepareVideo(source, file.name)
              .then((value) => {
                if (generation.current === captured) {
                  setDraft({ ...value, file });
                  setSubmitted(false);
                }
              })
              .catch((cause: unknown) => {
                if (generation.current === captured)
                  setError(cause instanceof Error ? cause.message : String(cause));
              })
              .finally(() => {
                URL.revokeObjectURL(source);
                if (generation.current === captured) setPreparing(false);
              });
          }}
        />
        <span>{preparing ? '正在读取视频' : draft?.fileName}</span>
        {draft && (
          <>
            <ActionIcon
              label="上传视频"
              disabled={a.disabled || submitted || preparing}
              onClick={() => {
                let videoId: string | null = null;
                let matched = false;
                void a.perform(
                  async (binding) => {
                    setSubmitted(true);
                    const captured = generation.current;
                    let uploadId: string | undefined;
                    try {
                      if (draft.file) {
                        const start = await client.account.qqActions.albumVideoStart.mutate({
                          ...binding,
                          size: draft.file.size,
                        });
                        uploadId = start.id;
                        for (let offset = 0; offset < draft.file.size; ) {
                          if (generation.current !== captured)
                            throw new Error('已停止传输：账号或相册已切换');
                          const chunk = draft.file.slice(offset, offset + 1024 * 1024);
                          const base64 = await new Promise<string>((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onerror = () => reject(new Error('视频文件读取失败'));
                            reader.onload = () =>
                              typeof reader.result === 'string'
                                ? resolve(reader.result.split(',')[1] ?? '')
                                : reject(new Error('视频文件读取失败'));
                            reader.readAsDataURL(chunk);
                          });
                          const result = await client.account.qqActions.albumVideoChunk.mutate({
                            ...binding,
                            uploadId,
                            offset,
                            base64,
                          });
                          if (result.offset !== offset + chunk.size)
                            throw new Error('宿主视频暂存偏移异常，已停止传输');
                          offset = result.offset;
                          if (generation.current === captured)
                            setProgress(Math.round((offset / draft.file.size) * 100));
                        }
                      }
                      if (generation.current !== captured)
                        throw new Error('已停止上传：账号或相册已切换');
                      const { file: _file, path, ...metadata } = draft;
                      const result = await client.account.qqActions.albumVideoUpload.mutate({
                        ...binding,
                        groupId,
                        albumId,
                        ...metadata,
                        path,
                        uploadId,
                      });
                      videoId = result.videoId;
                      return result;
                    } finally {
                      if (uploadId)
                        await client.account.qqActions.albumVideoDiscard
                          .mutate({ ...binding, uploadId })
                          .catch(() => {});
                      if (generation.current === captured) setProgress(null);
                    }
                  },
                  async () => {
                    if (matched) {
                      onChanged();
                      setDraft(null);
                      setSubmitted(false);
                    }
                  },
                  '将视频和封面上传到当前群相册？',
                  {
                    requireReadback: true,
                    readbackSuccessText: '视频已发布到群相册',
                    readback: async () => {
                      if (!videoId) return false;
                      const rows = await client.account.listGroupAlbumMedia.query({
                        groupCode: String(groupId),
                        albumId,
                      });
                      matched = rows.some(
                        (row) =>
                          row.video?.id === videoId &&
                          row.uploader === a.binding?.expectedAccountUin,
                      );
                      return matched;
                    },
                  },
                );
              }}
            >
              <Upload size={16} />
            </ActionIcon>
            <ActionIcon
              label="移除所选视频"
              disabled={a.disabled || submitted || preparing}
              onClick={() => setDraft(null)}
            >
              <X size={16} />
            </ActionIcon>
          </>
        )}
      </div>
      {draft && (
        <img
          className="weq-album-video-cover"
          src={`data:image/jpeg;base64,${draft.coverBase64}`}
          alt="视频封面"
        />
      )}
      {error && <p role="alert">{error}</p>}
      {progress !== null && <progress max={100} value={progress} aria-label="视频传到宿主的进度" />}
      {submitted && !a.busy && (
        <p role="status">本次上传已尝试，请在相册中核对结果后再选择其他视频。</p>
      )}
    </div>
  );
}
export const GroupAlbumVideoUpload = withQQAccountScope(GroupAlbumVideoUploadBody);
