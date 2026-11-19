import { Download, X } from 'lucide-react';
import type { MediaSaveSource } from '../../../shared/media_save';
import { IS_WEB } from '../lib/target.shared';
import { useRemoteClient } from '../lib/remoteClient';
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
  const remote = useRemoteClient();
  const transfer = useTransferProgress(mediaTransferTarget(source));
  const working = save.isBusy(source);
  const progress = transfer ?? (working ? { phase: 'preparing' as const } : undefined);
  return (
    <div
      className="weq-save-action-group weq-media-save-controls"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {progress ? (
        <span className={`${className} weq-transfer-control`}>
          <TransferRing progress={progress} size={19} />
          {iconOnly ? null : <span>{remote ? '下载' : IS_WEB ? '保存到服务器' : '保存'}</span>}
        </span>
      ) : (
        <button
          type="button"
          className={className}
          title={remote ? `${label}到设备` : IS_WEB ? `${label}到服务器` : label}
          aria-label={label}
          disabled={save.disabled}
          onClick={() => void save.run(source)}
        >
          <Download size={15} />
          {iconOnly ? null : <span>{remote ? '下载' : IS_WEB ? '保存到服务器' : '保存'}</span>}
        </button>
      )}
      {save.downloading && working && (
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
