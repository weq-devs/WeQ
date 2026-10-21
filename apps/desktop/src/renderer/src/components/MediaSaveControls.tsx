import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import type { ExportSavePolicy } from '@weq/service';
import type { MediaSaveSource } from '../../../shared/media_save';
import { client } from '../trpc/client';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { IS_WEB } from '../lib/target';
import { RenderDocumentContext, useRenderDocument } from '../lib/renderDocument';
import { ExportSaveActions } from './ExportSaveActions';
import { ServerSavePrompt } from './ServerSavePrompt';
import { useToast } from './Toast';
import '../styles/media-save.css';

function sourceKey(source: MediaSaveSource): string {
  return JSON.stringify(source);
}
function sourceName(source: MediaSaveSource): string {
  return source.kind === 'group-file' ? source.fileName : source.name || '媒体文件';
}
function normalizeSource(source: MediaSaveSource): MediaSaveSource {
  if (source.kind !== 'url' || !IS_WEB) return structuredClone(source);
  const url = new URL(source.url, window.location.href);
  return {
    ...source,
    url:
      url.origin === window.location.origin && /^\/_(?:media|asset)\//.test(url.pathname)
        ? `${url.pathname}${url.search}`
        : source.url,
  };
}
async function pause(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, 1000);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function useMediaSave() {
  const save = useExportSavePolicy(),
    document = useRenderDocument();
  const push = useToast((state) => state.push);
  const identity = `${save.binding?.expectedAccountUin}:${save.binding?.expectedAccountConfigId}`;
  const [operation, setOperation] = useState<{
    identity: string;
    key: string;
    browser: boolean;
  } | null>(null);
  const pending = useRef<{
    identity: string;
    controller: AbortController;
    taskId: string | null;
    expected: NonNullable<typeof save.binding>;
    cancelled: boolean;
  } | null>(null);
  useEffect(
    () => () => {
      if (pending.current?.identity === identity) pending.current.controller.abort();
    },
    [identity],
  );
  const busy = operation?.identity === identity;
  async function stopTask(op: NonNullable<typeof pending.current>) {
    if (!op.taskId) return;
    try {
      await client.account.mediaSave.cancel.mutate({ ...op.expected, taskId: op.taskId });
    } catch (error) {
      if (save.isCurrent())
        push({
          tone: 'error',
          title: '停止请求未确认，任务可能仍在后台',
          detail: error instanceof Error ? error.message : String(error),
        });
    }
  }
  async function cancel() {
    const op = pending.current;
    if (!op || op.identity !== identity) return;
    op.cancelled = true;
    op.controller.abort();
    await stopTask(op);
  }
  async function run(
    source: MediaSaveSource,
    intent?: ExportSavePolicy,
    browser = false,
  ): Promise<{ taskId: string | null; error?: string; cancelled?: boolean }> {
    if (!save.binding || pending.current?.identity === identity || save.settings.isLoading)
      return { taskId: null };
    const op = {
      identity,
      controller: new AbortController(),
      taskId: null as string | null,
      expected: { ...save.binding },
      cancelled: false,
    };
    pending.current = op;
    setOperation({ identity, key: sourceKey(source), browser });
    const current = () =>
      pending.current === op && save.isCurrent() && !op.controller.signal.aborted;
    try {
      const selected = normalizeSource(source);
      const policy = browser
        ? { mode: 'after' as const }
        : IS_WEB
          ? await save.prepareSave(intent, { kind: 'bundle', name: sourceName(source) })
          : (intent ?? save.policy);
      if (!policy || !current()) return { taskId: null, cancelled: true };
      op.taskId = await client.account.mediaSave.save.mutate({
        ...op.expected,
        source: selected,
        savePolicy: policy,
      });
      if (op.cancelled && op.taskId) await stopTask(op);
      if (!op.taskId || !current()) return { taskId: op.taskId, cancelled: true };
      if (!browser) {
        push({ tone: 'info', title: '媒体保存任务已创建' });
        return { taskId: op.taskId };
      }
      push({ tone: 'info', title: '媒体下载任务已创建' });
      const deadline = Date.now() + 15 * 60_000;
      while (current() && Date.now() < deadline) {
        const receipt = await client.account.getExportOutputReceipt.query({
          ...op.expected,
          taskId: op.taskId,
        });
        if (!current()) break;
        if (!receipt) throw new Error('下载任务已被清理');
        if (receipt.status === 'failed') throw new Error(receipt.error || '媒体不可用');
        if (receipt.status === 'cancelled' || receipt.status === 'paused')
          return { taskId: op.taskId, cancelled: true };
        if (receipt.status === 'completed') {
          const result = await client.account.exportTaskDownload.mutate({
            ...op.expected,
            taskId: op.taskId,
          });
          if (!current()) break;
          if (!result) throw new Error('当前环境不支持浏览器下载');
          const link = document.createElement('a');
          link.href = result.url;
          link.download = '';
          document.body.append(link);
          link.click();
          link.remove();
          return { taskId: op.taskId };
        }
        await pause(op.controller.signal);
      }
      if (current()) push({ tone: 'info', title: '文件仍在后台处理，结果将保留在任务列表' });
      return { taskId: op.taskId, cancelled: !current() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (current()) {
        push({ tone: 'error', title: '媒体保存失败', detail: message });
        return { taskId: op.taskId, error: message };
      }
      return { taskId: op.taskId, cancelled: true };
    } finally {
      if (pending.current === op) pending.current = null;
      setOperation((previous) => (previous?.identity === identity ? null : previous));
    }
  }
  return {
    run,
    cancel,
    busy,
    disabled: busy || !save.binding || save.settings.isLoading,
    isBusy: (source: MediaSaveSource) => busy && operation?.key === sourceKey(source),
    downloading: busy && operation?.browser,
    prompt: save.serverLocation ? (
      <ServerSavePrompt
        name={save.serverLocation.name}
        onChoose={save.chooseServerLocation}
        portalTarget={document.body}
      />
    ) : null,
  };
}

export function MediaSaveControls({
  save,
  source,
  className,
  label = '保存媒体',
  iconOnly = false,
}: {
  save: ReturnType<typeof useMediaSave>;
  source: MediaSaveSource;
  className: string;
  label?: string;
  iconOnly?: boolean;
}) {
  return (
    <div
      className="weq-save-action-group weq-media-save-controls"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={className}
        title={IS_WEB ? `${label}到服务器` : label}
        aria-label={label}
        disabled={save.disabled}
        onClick={() => void save.run(source)}
      >
        {save.isBusy(source) ? <Loader2 size={15} className="weq-spin" /> : <Download size={15} />}
        {iconOnly ? null : <span>{IS_WEB ? '保存到服务器' : '保存'}</span>}
      </button>
      <ExportSaveActions
        disabled={save.disabled}
        onSelect={(intent) => void save.run(source, intent)}
        label={`${label}的本次保存选项`}
      />
      {IS_WEB && (
        <button
          type="button"
          className={className}
          title="下载到浏览器"
          aria-label={`${label}到浏览器`}
          disabled={save.disabled}
          onClick={() => void save.run(source, undefined, true)}
        >
          <Download size={15} />
        </button>
      )}
      {save.downloading && save.isBusy(source) && (
        <button
          type="button"
          className={className}
          title="停止本次下载"
          aria-label="停止本次下载"
          onClick={() => void save.cancel()}
        >
          <X size={15} />
        </button>
      )}
    </div>
  );
}
function SourceSave({
  source,
  ...props
}: {
  source: MediaSaveSource;
  className: string;
  label?: string;
  iconOnly?: boolean;
}) {
  const save = useMediaSave();
  return (
    <>
      <MediaSaveControls {...props} source={source} save={save} />
      {save.prompt}
    </>
  );
}
export function MediaSourceSave({
  ownerDocument,
  ...props
}: {
  source: MediaSaveSource;
  className: string;
  label?: string;
  iconOnly?: boolean;
  ownerDocument?: Document;
}) {
  const currentDocument = useRenderDocument();
  return (
    <RenderDocumentContext.Provider value={ownerDocument ?? currentDocument}>
      <SourceSave {...props} />
    </RenderDocumentContext.Provider>
  );
}
