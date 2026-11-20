import { useEffect, useRef, useState } from 'react';
import { TaskProgressBar } from '../tasks/TaskProgressBar';
import { Film, ListTodo, RefreshCw, Square, Upload, X } from 'lucide-react';
import { client, trpc } from '../../trpc/client';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { mediaUrl } from '../../lib/resourceUrl';
import { useDraftProtection } from '../../lib/draftClose';
import { ActionIcon } from './shared';
import { useQQAction, useQQAlbumPermissions, withQQAccountScope } from './shared.shared';

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
function readVideoChunk(chunk: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('视频文件读取失败'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result.split(',')[1] ?? '')
        : reject(new Error('视频文件读取失败'));
    reader.readAsDataURL(chunk);
  });
}

async function leaveUploadRunning(attempt: {
  input: QQWriteBinding & { groupId: number; albumId: string };
  requestId: string;
  taskId?: string;
}) {
  const task = await client.account.qqActions.albumVideoStatus.query(attempt.input);
  if (task?.requestId !== attempt.requestId || (attempt.taskId && attempt.taskId !== task.id))
    return;
  if (task.foreground && (task.status === 'running' || task.status === 'paused'))
    await client.account.qqActions.albumVideoBackground.mutate({
      ...attempt.input,
      taskId: task.id,
    });
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
  const a = useQQAction(`album-video:${groupId}:${albumId}`, 'failure-only');
  const permissions = useQQAlbumPermissions(groupId, albumId, a);
  const uploadAllowed = permissions.data?.upload === true && !permissions.error;
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<VideoDraft | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [acting, setActing] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const stopping = useRef(false);
  const attempt = useRef<{
    input: QQWriteBinding & { groupId: number; albumId: string };
    requestId: string;
    taskId?: string;
  } | null>(null);
  const refreshed = useRef('');
  const input = { ...a.binding!, groupId, albumId };
  const status = trpc.account.qqActions.albumVideoStatus.useQuery(input, {
    enabled: Boolean(a.binding),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (row) =>
      row?.status === 'running' || (a.busy && Boolean(requestId) && row?.requestId !== requestId)
        ? 1000
        : false,
  });
  const task = !requestId || requestId === status.data?.requestId ? status.data : undefined;
  const pendingHost = Boolean(requestId && !task);
  const running = task?.status === 'running';
  const submitted = Boolean(requestId) || running;
  useDraftProtection(submitted ? null : draft, a.busy || preparing);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      const current = attempt.current;
      if (!current) return;
      queueMicrotask(() => {
        if (!mounted.current) void leaveUploadRunning(current).catch(() => undefined);
      });
    };
  }, []);
  useEffect(() => {
    if (task?.status !== 'completed' || refreshed.current === task.id) return;
    refreshed.current = task.id;
    setDraft(null);
    onChanged();
  }, [task, onChanged]);

  function publish(draft: VideoDraft) {
    if (submitted) return;
    setError('');
    void a.perform(
      async (binding) => {
        stopping.current = false;
        let uploadId: string | undefined;
        let submittedToHost = false;
        const captured = generation.current;
        const assertCurrent = () => {
          if (stopping.current || captured !== generation.current)
            throw new DOMException('已停止传输视频到宿主', 'AbortError');
        };
        try {
          if (draft.file) {
            setProgress(0);
            const stage = await client.account.qqActions.albumVideoStart.mutate({
              ...binding,
              size: draft.file.size,
            });
            uploadId = stage.id;
            for (let offset = 0; offset < draft.file.size; ) {
              assertCurrent();
              const chunk = draft.file.slice(offset, offset + 1024 * 1024);
              const base64 = await readVideoChunk(chunk);
              assertCurrent();
              const result = await client.account.qqActions.albumVideoChunk.mutate({
                ...binding,
                uploadId,
                offset,
                base64,
              });
              if (result.offset !== offset + chunk.size)
                throw new Error('宿主视频暂存偏移异常，已停止传输');
              offset = result.offset;
              if (mounted.current) setProgress(Math.round((offset / draft.file.size) * 100));
            }
          }
          assertCurrent();
          const requestId = globalThis.crypto.randomUUID();
          const current: NonNullable<typeof attempt.current> = {
            input: { ...binding, groupId, albumId },
            requestId,
          };
          attempt.current = current;
          submittedToHost = true;
          setRequestId(requestId);
          setProgress(null);
          const { file: _file, path, ...metadata } = draft;
          current.taskId = await client.account.qqActions.albumVideoPublish.mutate({
            ...current.input,
            ...metadata,
            requestId,
            path,
            uploadId,
          });
          if (!mounted.current) await leaveUploadRunning(current);
          else await status.refetch();
          return { state: 'accepted' };
        } catch (reason) {
          if (mounted.current) {
            if (reason instanceof DOMException && reason.name === 'AbortError')
              setError(reason.message);
            else setError(reason instanceof Error ? reason.message : String(reason));
          }
          return { state: 'unchanged' };
        } finally {
          if (uploadId && !submittedToHost)
            await client.account.qqActions.albumVideoDiscard
              .mutate({ ...binding, uploadId })
              .catch(() => undefined);
          if (mounted.current) setProgress(null);
        }
      },
      undefined,
      '将视频和封面上传到当前群相册？',
      { refreshCaches: false },
    );
  }
  async function control(action: 'background' | 'verify') {
    if (!a.binding || !task || acting) return;
    setActing(true);
    setError('');
    try {
      const ref = { ...input, taskId: task.id };
      if (action === 'background') await client.account.qqActions.albumVideoBackground.mutate(ref);
      else await client.account.qqActions.albumVideoVerify.mutate(ref);
      await status.refetch();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (mounted.current) setActing(false);
    }
  }
  return (
    <div className="weq-qq-actions">
      <div className="weq-qq-action-bar">
        <ActionIcon
          label="选择视频"
          disabled={a.disabled || !uploadAllowed || preparing || running}
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
                  setRequestId(null);
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
                  setRequestId(null);
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
              disabled={a.disabled || !uploadAllowed || submitted || preparing}
              onClick={() => publish(draft)}
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
      {progress !== null && (
        <>
          <TaskProgressBar value={progress} label="视频传到宿主的进度" />
          <ActionIcon
            label="停止传输到宿主"
            text="停止传输"
            onClick={() => {
              stopping.current = true;
            }}
          >
            <Square size={14} />
          </ActionIcon>
        </>
      )}
      {pendingHost && (
        <div className="weq-qq-action-bar">
          <p role="status">{a.busy ? '正在确认宿主是否受理上传…' : '宿主受理结果待核对'}</p>
          {!a.busy && (
            <ActionIcon
              label="重新读取上传状态"
              text="重新读取状态"
              onClick={() => void status.refetch()}
            >
              <RefreshCw size={14} />
            </ActionIcon>
          )}
        </div>
      )}
      {task && progress === null && (
        <div className="weq-qq-action-bar">
          <p role="status">{task.statusLabel ?? task.note ?? '正在处理视频上传'}</p>
          {task.statusLabel && task.note && <p>{task.note}</p>}
          {task.foreground && (running || task.status === 'paused') && (
            <ActionIcon
              label="在后台继续上传视频"
              text="后台进行"
              disabled={acting}
              onClick={() => void control('background')}
            >
              <ListTodo size={14} />
            </ActionIcon>
          )}
          {task.canVerify && (
            <ActionIcon
              label="核对上传结果"
              text="核对上传结果"
              disabled={acting || !a.available}
              onClick={() => void control('verify')}
            >
              <RefreshCw size={14} />
            </ActionIcon>
          )}
        </div>
      )}
    </div>
  );
}
export const GroupAlbumVideoUpload = withQQAccountScope(GroupAlbumVideoUploadBody, (props) => ({
  kind: 'group-resource',
  request: {
    kind: 'albums',
    groupCode: String(props.groupId),
    groupName: String(props.groupId),
    initialAlbumId: props.albumId,
  },
}));
