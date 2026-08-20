/**
 * 闪传下载任务管理弹窗 —— 从浏览弹窗的「下载任务」进入。
 *
 * 列出全部任务（含历史，落盘持久化），实时订阅单文件进度；支持取消进行中的
 * 任务、清除已结束的任务、在系统文件管理器打开下载根目录。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { Check, Download, FolderOpen, Loader2, Trash2, X } from 'lucide-react';
import { Modal } from './Dialog';
import { client } from '../trpc/client';
import { fileIconUrl } from '../lib/resourceUrl';
import { useToast } from './Toast';
import '../styles/flash-transfer.css';

type TaskStatus = 'pending' | 'resolving' | 'downloading' | 'done' | 'failed' | 'cancelled';

interface FlashTask {
  id: string;
  filesetId: string;
  filesetName: string;
  name: string;
  relativePath: string;
  targetPath: string;
  fileSize: number;
  status: TaskStatus;
  downloadedBytes: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: '等待中',
  resolving: '获取链接',
  downloading: '下载中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function fileExtIcon(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    doc: 'doc.png',
    docx: 'doc.png',
    xls: 'xls.png',
    xlsx: 'xls.png',
    ppt: 'ppt.png',
    pptx: 'ppt.png',
    pdf: 'pdf.png',
    zip: 'rar.png',
    '7z': 'rar.png',
    rar: 'rar.png',
    gz: 'rar.png',
    tar: 'rar.png',
    exe: 'exe.png',
    msi: 'exe.png',
    mp3: 'audio.png',
    wav: 'audio.png',
    flac: 'audio.png',
    mp4: 'video.png',
    avi: 'video.png',
    mkv: 'video.png',
    mov: 'video.png',
    png: 'image.png',
    jpg: 'image.png',
    jpeg: 'image.png',
    gif: 'image.png',
    webp: 'image.png',
    svg: 'image.png',
    txt: 'txt.png',
    md: 'txt.png',
    log: 'txt.png',
    js: 'code.png',
    ts: 'code.png',
    tsx: 'code.png',
    py: 'code.png',
    go: 'code.png',
    html: 'code.png',
    css: 'code.png',
    apk: 'apk.png',
    dmg: 'dmg.png',
    ipa: 'ipa.png',
    pkg: 'pkg.png',
    bak: 'bak.png',
  };
  return map[ext] ?? 'unknown.png';
}

const isActive = (status: TaskStatus): boolean =>
  status === 'pending' || status === 'resolving' || status === 'downloading';

export function FlashTransferTasksDialog({ onClose }: { onClose: () => void }): ReactElement {
  const pushToast = useToast((s) => s.push);
  const [tasks, setTasks] = useState<FlashTask[]>([]);
  const [loading, setLoading] = useState(true);
  const busyRef = useRef(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await client.account.flashListDownloadTasks.query();
      setTasks((list as FlashTask[]) ?? []);
    } catch (e) {
      pushToast({
        tone: 'error',
        message: '加载下载任务失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void refresh();
    const sub = client.account.onFlashDownloadProgress.subscribe(undefined, {
      onData: (task) => {
        setTasks((prev) => {
          const next = prev.slice();
          const idx = next.findIndex((t) => t.id === task.id);
          const wire = task as FlashTask;
          if (idx >= 0) next[idx] = wire;
          else next.unshift(wire);
          return next;
        });
      },
      onError: (err) => console.error('[flash] download progress subscription error', err),
    });
    return () => sub.unsubscribe();
  }, [refresh]);

  const handleCancel = async (taskId: string): Promise<void> => {
    await client.account.flashCancelDownloadTask.mutate({ taskId });
  };

  const handleClear = async (): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const removed = await client.account.flashClearDownloadTasks.mutate();
      await refresh();
      pushToast({ tone: 'success', message: `已清除 ${removed} 个已完成任务` });
    } catch (e) {
      pushToast({
        tone: 'error',
        message: '清除失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    } finally {
      busyRef.current = false;
    }
  };

  const handleOpenDir = async (): Promise<void> => {
    try {
      await client.account.flashRevealDownloadDir.mutate();
    } catch (e) {
      pushToast({
        tone: 'error',
        message: '打开目录失败',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const hasFinished = tasks.some((t) => !isActive(t.status));

  return (
    <Modal onClose={onClose} width={560}>
      <div className="weq-ft weq-ft-tasks">
        <header className="weq-ft-head">
          <span className="weq-ft-title">闪传下载任务</span>
          <div className="weq-ft-actions">
            <button
              type="button"
              className="weq-ft-btn"
              onClick={() => void handleOpenDir()}
              title="打开下载目录"
            >
              <FolderOpen size={15} strokeWidth={1.9} aria-hidden />
              <span>打开目录</span>
            </button>
            <button
              type="button"
              className="weq-ft-btn"
              onClick={() => void handleClear()}
              disabled={!hasFinished}
              title="清除已完成"
            >
              <Trash2 size={15} strokeWidth={1.9} aria-hidden />
              <span>清除已完成</span>
            </button>
            <button
              type="button"
              className="weq-ft-close"
              onClick={onClose}
              aria-label="关闭"
              title="关闭"
            >
              <X size={16} strokeWidth={1.9} aria-hidden />
            </button>
          </div>
        </header>

        <div className="weq-ft-body">
          {loading ? (
            <div className="weq-ft-loading">
              <Loader2 size={22} strokeWidth={1.9} className="weq-spin" aria-hidden />
            </div>
          ) : tasks.length === 0 ? (
            <div className="weq-ft-empty">
              <Download size={34} strokeWidth={1.5} aria-hidden />
              <p>还没有下载任务</p>
            </div>
          ) : (
            <div className="weq-ft-task-list">
              {tasks.map((task) => {
                const active = isActive(task.status);
                const pct =
                  task.fileSize > 0
                    ? Math.min(
                        100,
                        Math.max(0, Math.floor((task.downloadedBytes / task.fileSize) * 100)),
                      )
                    : 0;
                return (
                  <div key={task.id} className={`weq-ft-task weq-ft-task-${task.status}`}>
                    <img
                      className="weq-ft-task-icon"
                      src={fileIconUrl(fileExtIcon(task.name))}
                      alt=""
                      draggable={false}
                    />
                    <div className="weq-ft-task-main">
                      <div className="weq-ft-task-title">
                        <span className="weq-ft-task-name" title={task.name}>
                          {task.name}
                        </span>
                        <span className={`weq-ft-task-badge weq-ft-task-badge-${task.status}`}>
                          {STATUS_LABEL[task.status]}
                        </span>
                      </div>
                      <div className="weq-ft-task-meta" title={task.targetPath}>
                        {task.relativePath} · {formatSize(task.fileSize)}
                      </div>
                      {active ? (
                        <div className="weq-ft-progress">
                          <div
                            className={`weq-ft-progress-fill${task.status === 'resolving' ? ' weq-ft-progress-indeterminate' : ''}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : null}
                      {task.status === 'downloading' && task.fileSize > 0 ? (
                        <div className="weq-ft-task-meta">
                          {formatSize(task.downloadedBytes)} / {formatSize(task.fileSize)} · {pct}%
                        </div>
                      ) : null}
                      {task.status === 'failed' && task.error ? (
                        <div className="weq-ft-task-error" title={task.error}>
                          {task.error}
                        </div>
                      ) : null}
                    </div>
                    {active ? (
                      <button
                        type="button"
                        className="weq-ft-task-cancel"
                        onClick={() => void handleCancel(task.id)}
                        title="取消"
                      >
                        <X size={14} strokeWidth={2} aria-hidden />
                      </button>
                    ) : task.status === 'done' ? (
                      <Check size={16} strokeWidth={2.4} className="weq-ft-task-done" aria-hidden />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
