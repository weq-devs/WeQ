/**
 * 助手报告附件卡片：展示 write_report 写出的本地文件（标题 / 类型 / 大小），
 * 查看保留既有隔离 HTML 查看器；保存复用全局偏好与任务回执，不重新调用模型。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Download,
  Eye,
  ExternalLink,
  FileCode2,
  FileText,
  FileType2,
  FolderArchive,
  FolderOpen,
} from 'lucide-react';
import type { AssistantArtifact, ExportSavePolicy } from '@weq/service';
import { client, trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useAppDialog } from '../../lib/dialogUtils';
import { useExportSavePolicy } from '../../hooks/useExportSavePolicy';
import { ExportSaveActions } from '../../components/ExportSaveActions';
import { ServerSavePrompt } from '../../components/ServerSavePrompt';
import { useToast } from '../../components/Toast';
import { IS_WEB } from '../../lib/target';
import '../../styles/assistant-artifact-save.css';

function kindIcon(kind: AssistantArtifact['kind']): ReactElement {
  if (kind === 'export') return <FolderArchive size={18} />;
  if (kind === 'html') return <FileCode2 size={18} />;
  if (kind === 'markdown') return <FileType2 size={18} />;
  return <FileText size={18} />;
}

function kindLabel(kind: AssistantArtifact['kind']): string {
  if (kind === 'export') return '导出';
  if (kind === 'html') return 'HTML 报告';
  if (kind === 'markdown') return 'Markdown';
  return '文本';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AssistantArtifactCard({ artifact }: { artifact: AssistantArtifact }): ReactElement {
  const dialog = useAppDialog();
  const isExport = artifact.kind === 'export';
  const { binding, prepareSave, isCurrent, serverLocation, chooseServerLocation } =
    useExportSavePolicy();
  const pushToast = useToast((state) => state.push);
  const utils = trpc.useUtils();
  const identity = `${binding?.expectedAccountUin ?? ''}:${binding?.expectedAccountConfigId ?? ''}:${artifact.kind}:${artifact.id}`;
  const latest = useRef(identity);
  latest.current = identity;
  const cancelLocation = useRef(chooseServerLocation);
  cancelLocation.current = chooseServerLocation;
  useEffect(() => {
    cancelLocation.current(null);
  }, [identity]);
  const pending = useRef<string | null>(null);
  const [operation, setOperation] = useState<{
    identity: string;
    kind: 'view' | 'save' | 'download';
  } | null>(null);
  const [failure, setFailure] = useState<{ identity: string; message: string } | null>(null);
  const [monitor, setMonitor] = useState<{ identity: string; taskId: string } | null>(null);
  const busy = operation?.identity === identity ? operation.kind : null;
  const taskId = monitor?.identity === identity ? monitor.taskId : null;
  const autoRefresh = useQQAutoRefresh(Boolean(binding && taskId));
  const current = () => latest.current === identity && isCurrent();
  const receipt = trpc.account.getExportOutputReceipt.useQuery(
    {
      expectedAccountUin: binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: binding?.expectedAccountConfigId ?? '',
      taskId: taskId ?? 'not-selected',
    },
    {
      ...autoRefresh,
      refetchInterval: (data) =>
        autoRefresh.enabled &&
        data &&
        (data.status === 'pending' ||
          data.status === 'running' ||
          data.save?.status === 'saving' ||
          (data.status === 'completed' &&
            data.save?.status === 'pending' &&
            data.save.policy.mode !== 'after'))
          ? 1000
          : false,
    },
  );

  async function onView(): Promise<void> {
    if (!binding || pending.current === identity || !current()) return;
    pending.current = identity;
    setOperation({ identity, kind: 'view' });
    const expected = { ...binding },
      id = artifact.id;
    try {
      if (isExport) await client.account.openAssistantExport.mutate({ ...expected, taskId: id });
      else await client.account.openAssistantArtifact.mutate({ ...expected, id });
    } catch (e) {
      if (current()) dialog.error('打开失败', e instanceof Error ? e.message : String(e));
    } finally {
      if (pending.current === identity) pending.current = null;
      setOperation((previous) => (previous?.identity === identity ? null : previous));
    }
  }

  async function onSave(intent?: ExportSavePolicy): Promise<void> {
    if (!binding || pending.current === identity || !current()) return;
    pending.current = identity;
    setOperation({ identity, kind: 'save' });
    setFailure(null);
    const expected = { ...binding },
      selected = { ...artifact };
    try {
      const candidate = isExport ? selected.id : taskId;
      let existing = candidate
        ? await client.account.getExportOutputReceipt.query({ ...expected, taskId: candidate })
        : null;
      if (!current()) return;
      if (isExport && !existing) throw new Error('导出结果不存在（可能已被清理）。');
      if (!isExport && existing && ['failed', 'cancelled', 'paused'].includes(existing.status))
        existing = null;
      if (existing && (existing.status !== 'completed' || !existing.output))
        throw new Error('导出结果尚未完成或已被清理。');
      const extension =
        selected.kind === 'markdown' ? 'md' : selected.kind === 'text' ? 'txt' : 'html';
      const output = existing?.output;
      const savePolicy = await prepareSave(
        intent,
        output?.kind === 'directory'
          ? { kind: 'bundle', name: existing!.name }
          : {
              kind: 'file',
              name:
                output?.kind === 'file'
                  ? output.name
                  : selected.name.replace(/\.[^.]+$/, '') || '助手报告',
              format: output?.kind === 'file' ? output.extension : extension,
            },
      );
      if (!savePolicy || !current()) return;
      let id: string;
      if (existing) {
        id = existing.id;
        if (savePolicy.mode !== 'after') {
          const path = await client.account.saveExportTaskOutput.mutate({
            ...expected,
            taskId: id,
            ...(savePolicy.directory ? { directory: savePolicy.directory } : {}),
            ...(savePolicy.filePath
              ? { filePath: savePolicy.filePath, uniqueFileName: savePolicy.uniqueFileName }
              : {}),
          });
          if (path === null || !current()) return;
        }
      } else {
        id = await client.account.startAssistantArtifactSave.mutate({
          ...expected,
          id: selected.id,
          name: selected.name,
          savePolicy,
        });
      }
      if (!current()) return;
      setMonitor({ identity, taskId: id });
      await utils.account.getExportOutputReceipt.invalidate({ ...expected, taskId: id });
      if (current() && (savePolicy.mode === 'after' || !existing))
        pushToast({
          tone: 'info',
          title:
            savePolicy.mode === 'after' ? '结果将保留在任务列表，等待保存' : '报告保存任务已创建',
        });
    } catch (e) {
      if (current()) setFailure({ identity, message: e instanceof Error ? e.message : String(e) });
    } finally {
      if (pending.current === identity) pending.current = null;
      setOperation((previous) => (previous?.identity === identity ? null : previous));
    }
  }

  async function openSaved(reveal: boolean) {
    if (!binding || !taskId || !current()) return;
    try {
      await client.account.openSavedExportOutput.mutate({ ...binding, taskId, reveal });
    } catch (error) {
      if (current())
        dialog.error('打开保存结果失败', error instanceof Error ? error.message : String(error));
    }
  }
  async function downloadInBrowser() {
    if (!binding || pending.current === identity || !current()) return;
    pending.current = identity;
    setOperation({ identity, kind: 'download' });
    setFailure(null);
    const expected = { ...binding },
      selected = { ...artifact },
      cached = taskId;
    try {
      const download =
        isExport || (cached && receipt.data?.status === 'completed')
          ? await client.account.exportTaskDownload.mutate({
              ...expected,
              taskId: isExport ? selected.id : cached!,
            })
          : await client.account.assistantArtifactDownload.mutate({
              ...expected,
              id: selected.id,
              name: selected.name,
            });
      if (!current()) return;
      if (!download) throw new Error('当前环境不能提供浏览器下载。');
      const anchor = document.createElement('a');
      anchor.href = download.url;
      anchor.download = '';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch (error) {
      if (current())
        setFailure({ identity, message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (pending.current === identity) pending.current = null;
      setOperation((previous) => (previous?.identity === identity ? null : previous));
    }
  }
  const saved = receipt.data?.save;
  const stateLabel =
    busy === 'save'
      ? '保存中'
      : saved?.status === 'saved'
        ? '已保存'
        : saved?.status === 'failed' || saved?.status === 'interrupted'
          ? '保存失败，可重试'
          : receipt.data?.status === 'failed'
            ? '生成失败'
            : receipt.data === null
              ? '结果已清理'
              : receipt.data?.status === 'paused'
                ? '已暂停'
                : receipt.data?.status === 'cancelled'
                  ? '已取消'
                  : saved?.status === 'saving'
                    ? '保存中'
                    : receipt.data?.status === 'completed'
                      ? '等待保存'
                      : taskId
                        ? '处理中'
                        : '';
  const error =
    failure?.identity === identity
      ? failure.message
      : (receipt.error?.message ?? receipt.data?.error ?? saved?.error);

  return (
    <div className="weq-asst-artifact weq-artifact-save-card" aria-busy={busy !== null}>
      {serverLocation && (
        <ServerSavePrompt name={serverLocation.name} onChoose={chooseServerLocation} />
      )}
      <span className="weq-asst-artifact-icon">{kindIcon(artifact.kind)}</span>
      <div className="weq-asst-artifact-meta">
        <span className="weq-asst-artifact-name" title={artifact.name}>
          {artifact.name}
        </span>
        <span className="weq-asst-artifact-sub">
          {kindLabel(artifact.kind)} · {formatBytes(artifact.bytes)}
          {stateLabel ? ` · ${stateLabel}` : ''}
        </span>
        {error && (
          <span className="weq-artifact-save-error" role="alert">
            {error}
          </span>
        )}
        {saved?.path && (
          <span className="weq-artifact-save-path" title={saved.path}>
            {saved.status === 'saved' ? '已保存：' : '上次保存：'}
            {saved.path}
          </span>
        )}
      </div>
      <div className="weq-asst-artifact-actions">
        <button
          type="button"
          className="weq-set-btn weq-set-btn-sm"
          disabled={busy !== null || !binding}
          onClick={() => void onView()}
        >
          <Eye size={13} /> {isExport ? '打开' : '查看'}
        </button>
        <button
          type="button"
          className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
          disabled={busy !== null || !binding}
          onClick={() => void onSave()}
        >
          <Download size={13} /> {IS_WEB ? '保存到服务器' : '保存'}
        </button>
        <ExportSaveActions
          disabled={busy !== null || !binding}
          onSelect={(intent) => void onSave(intent)}
        />
        {IS_WEB && (
          <button
            type="button"
            className="weq-artifact-saved-icon"
            disabled={busy !== null || !binding}
            title="下载到浏览器"
            aria-label="下载到浏览器"
            onClick={() => void downloadInBrowser()}
          >
            <Download size={14} />
          </button>
        )}
        {saved?.path && !IS_WEB && (
          <>
            <button
              type="button"
              className="weq-artifact-saved-icon"
              title="打开保存结果"
              aria-label="打开保存结果"
              onClick={() => void openSaved(false)}
            >
              <ExternalLink size={14} />
            </button>
            <button
              type="button"
              className="weq-artifact-saved-icon"
              title="在文件夹中显示"
              aria-label="在文件夹中显示"
              onClick={() => void openSaved(true)}
            >
              <FolderOpen size={14} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
