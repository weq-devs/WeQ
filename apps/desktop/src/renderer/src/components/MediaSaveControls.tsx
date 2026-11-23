import { AlertCircle, Check, Download, ListTodo, Play, X } from 'lucide-react';
import type { MediaSaveSource } from '../../../shared/media_save';
import { IS_WEB } from '../lib/target.shared';
import { RenderDocumentContext, useRenderDocument } from '../lib/renderDocument';
import '../styles/media-save.css';
import { useMediaSave } from './MediaSaveControls.shared';
import { mediaTransferTarget } from '../../../shared/transfer_progress';
import { useTransferProgress } from '../lib/transferActivity';
import { TransferRing } from './TransferRing';

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
  const transfer = useTransferProgress(mediaTransferTarget(source));
  const working = save.isBusy(source);
  const record = save.recordFor?.(source);
  const paused = !working && record?.status === 'paused';
  const saved = !working && (record?.status === 'saved' || record?.status === 'downloaded');
  const progress =
    saved || paused
      ? undefined
      : (transfer ?? (working ? { phase: 'preparing' as const } : undefined));
  return (
    <div
      className="weq-save-action-group weq-media-save-controls"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {saved ? (
        <button
          type="button"
          className={className}
          title={IS_WEB ? '下载到此设备' : '打开已保存文件'}
          aria-label={IS_WEB ? '下载到此设备' : '打开已保存文件'}
          onClick={() => void save.control(source, 'open')}
        >
          {IS_WEB ? <Download size={15} /> : <Check size={15} />}
          {iconOnly ? null : <span>{IS_WEB ? '再次下载' : '打开已保存文件'}</span>}
        </button>
      ) : paused ? (
        <button
          type="button"
          className={className}
          disabled={working}
          title={record.error ?? '继续下载'}
          aria-label="继续下载"
          onClick={() => void save.control(source, 'resume')}
        >
          <Play size={15} />
          {iconOnly ? null : <span>继续下载</span>}
        </button>
      ) : progress ? (
        <span className={`${className} weq-transfer-control`}>
          <TransferRing progress={progress} size={19} />
          {iconOnly ? null : <span>{IS_WEB ? '下载' : '保存'}</span>}
        </span>
      ) : (
        <button
          type="button"
          className={className}
          title="另存为"
          aria-label={label}
          disabled={save.disabled}
          onClick={() => void save.run(source)}
        >
          <Download size={15} />
          {iconOnly ? null : <span>另存为</span>}
        </button>
      )}
      {saved && !IS_WEB && (
        <button
          type="button"
          className={className}
          title={label}
          aria-label={label}
          disabled={save.disabled}
          onClick={() => void save.run(source)}
        >
          <Download size={15} aria-hidden />
          {iconOnly ? null : <span>再次保存</span>}
        </button>
      )}
      {record?.status === 'failed' && (
        <span
          className="weq-media-save-error"
          role="status"
          title={record.error}
          aria-label={`保存失败：${record.error ?? '请重试'}`}
        >
          <AlertCircle size={15} aria-hidden />
          {!iconOnly && record.error}
        </span>
      )}
      {record && (record.status === 'running' || paused) && (
        <button
          type="button"
          className={className}
          title="后台进行"
          aria-label="后台进行"
          onClick={() => void save.control(source, 'background')}
        >
          <ListTodo size={15} aria-hidden />
          {iconOnly ? null : <span>后台进行</span>}
        </button>
      )}
      {(((save.downloading || save.foreground) && working) || paused) && (
        <button
          type="button"
          className={className}
          title="停止本次下载"
          aria-label="停止本次下载"
          onClick={() => void save.cancel(source)}
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
  const save = useMediaSave({ foreground: true });
  return <MediaSaveControls {...props} source={source} save={save} />;
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
