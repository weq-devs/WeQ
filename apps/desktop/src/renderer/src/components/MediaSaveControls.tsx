import { Download, Loader2, X } from 'lucide-react';
import type { MediaSaveSource } from '../../../shared/media_save';
import { IS_WEB } from '../lib/target.shared';
import { useRemoteClient } from '../lib/remoteClient';
import { RenderDocumentContext, useRenderDocument } from '../lib/renderDocument';
import '../styles/media-save.css';
import { useMediaSave } from './MediaSaveControls.shared';

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
  return (
    <div
      className="weq-save-action-group weq-media-save-controls"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className={className}
        title={remote ? `${label}到设备` : IS_WEB ? `${label}到服务器` : label}
        aria-label={label}
        disabled={save.disabled}
        onClick={() => void save.run(source)}
      >
        {save.isBusy(source) ? <Loader2 size={15} className="weq-spin" /> : <Download size={15} />}
        {iconOnly ? null : <span>{remote ? '下载' : IS_WEB ? '保存到服务器' : '保存'}</span>}
      </button>
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
