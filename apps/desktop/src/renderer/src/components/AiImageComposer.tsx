import { useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { ImagePlus, Send, X } from 'lucide-react';
import type { AiImageRef, AiImageOutcome } from '@weq/agentlab';
import { client } from '../trpc/client';
import { stageAccountFile } from '../lib/accountFilePicker';
import { mediaUrl } from '../lib/resourceUrl';
import { aiImageDraft, parseAiImageDraft } from '../lib/aiImageDraft';
import { MediaPreview } from './MediaPreview';
import '../styles/ai-images.css';

const source = (image: AiImageRef) => mediaUrl('ai-image', { id: image.id });
export function AiImageGallery({
  images = [],
  outcomes = [],
  onRemove,
  variant = 'message',
}: {
  images?: AiImageRef[];
  outcomes?: AiImageOutcome[];
  onRemove?: (id: string) => void;
  variant?: 'draft' | 'message';
}) {
  const [selected, setSelected] = useState<string>();
  if (!images.length) return null;
  return (
    <>
      <div className={`weq-ai-images${variant === 'draft' ? ' is-draft' : ' is-history'}`}>
        {images.map((image) => {
          const outcome = outcomes.find((outcome) => outcome.id === image.id);
          return (
            <div key={image.id} className="weq-ai-image">
              <button
                type="button"
                className="weq-ai-image-open"
                title={outcome?.notes.join('\n') || image.name || '查看图片'}
                onClick={(event) => {
                  if (!event.currentTarget.closest('.selection-mode')) setSelected(image.id);
                }}
              >
                <img src={source(image)} alt={image.name || '图片'} loading="lazy" />
                {outcome?.status === 'failed' ? (
                  <span>未能读取</span>
                ) : outcome?.notes.some((note) => note.includes('回退 OCR')) ? (
                  <span>已回退 OCR</span>
                ) : outcome?.status === 'skipped' && outcome.mode !== 'placeholder' ? (
                  <span>未检测到文字</span>
                ) : null}
              </button>
              {onRemove ? (
                <button
                  type="button"
                  className="weq-ai-image-remove"
                  aria-label={`移除${image.name || '图片'}`}
                  title="移除图片"
                  onClick={() => onRemove(image.id)}
                >
                  <X size={14} />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {selected ? (
        <MediaPreview
          items={images.map((image) => ({
            key: image.id,
            kind: 'image',
            src: source(image),
            title: image.name,
          }))}
          initialKey={selected}
          onClose={() => setSelected(undefined)}
        />
      ) : null}
    </>
  );
}

export function AiImageComposer({
  value,
  setValue,
  disabled = false,
  onBusyChange,
  onSendImages,
  fill,
  children,
}: {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onSendImages?: () => void;
  fill?: boolean;
  children: ReactNode | ((controls: ReactNode) => ReactNode);
}) {
  const picker = useRef<HTMLInputElement>(null);
  const activeUploads = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const draft = parseAiImageDraft(value);
  async function add(files: File[]) {
    if (disabled || activeUploads.current || !files.length) return;
    if (draft.images.length + files.length > 32) {
      setError('每条消息最多 32 张图片');
      return;
    }
    setError('');
    activeUploads.current++;
    setBusy(true);
    onBusyChange?.(true);
    try {
      for (const file of files) {
        if (!file.type.startsWith('image/') || !file.size || file.size > 32 * 1024 * 1024)
          throw new Error('请选择 32 MiB 以内的图片');
        const config = await client.account.getAccountConfig.query();
        if (!config) throw new Error('请先打开账号');
        const binding = {
          expectedAccountUin: String(config.uin),
          expectedAccountConfigId: config.configId,
        };
        const staged = await stageAccountFile(file, binding);
        try {
          const image = {
            ...(await client.account.retainAiImage.mutate({ path: staged.path })),
            name: file.name,
          };
          setValue((current) => {
            const draft = parseAiImageDraft(current);
            if (draft.images.some((item) => item.id === image.id)) return current;
            return aiImageDraft(draft.text, [...draft.images, image]);
          });
        } finally {
          await client.account.pickedFileDiscard
            .mutate({ ...binding, uploadId: staged.uploadId })
            .catch(() => {});
        }
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      activeUploads.current--;
      const pending = activeUploads.current > 0;
      setBusy(pending);
      onBusyChange?.(pending);
    }
  }
  const controls = (
    <div className="weq-ai-attachments">
      <button
        type="button"
        className="weq-set-iconbtn"
        aria-label="添加图片"
        title="添加图片"
        disabled={disabled || busy}
        onClick={() => picker.current?.click()}
      >
        <ImagePlus size={18} />
      </button>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => {
          void add([...(event.target.files ?? [])]);
          event.target.value = '';
        }}
      />
      <AiImageGallery
        variant="draft"
        images={draft.images}
        onRemove={
          disabled
            ? undefined
            : (id) =>
                setValue((current) => {
                  const draft = parseAiImageDraft(current);
                  return aiImageDraft(
                    draft.text,
                    draft.images.filter((image) => image.id !== id),
                  );
                })
        }
      />
      {busy ? <span role="status">正在准备图片…</span> : null}
      {error ? <span role="alert">{error}</span> : null}
    </div>
  );
  return (
    <div
      className={`weq-ai-composer${fill ? ' is-fill' : ''}`}
      aria-busy={busy}
      onKeyDownCapture={(event) => {
        if (
          onSendImages &&
          !disabled &&
          !busy &&
          draft.images.length &&
          !draft.text.trim() &&
          event.key === 'Enter' &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          event.stopPropagation();
          onSendImages();
        }
      }}
      onPasteCapture={(event) => {
        const images = [...event.clipboardData.files].filter((file) =>
          file.type.startsWith('image/'),
        );
        if (images.length) {
          event.preventDefault();
          event.stopPropagation();
          void add(images);
        }
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDropCapture={(event) => {
        const images = [...event.dataTransfer.files].filter((file) =>
          file.type.startsWith('image/'),
        );
        if (images.length) {
          event.preventDefault();
          event.stopPropagation();
          void add(images);
        }
      }}
    >
      {typeof children === 'function' ? (
        children(controls)
      ) : (
        <>
          {children}
          {controls}
          {onSendImages && draft.images.length && !draft.text.trim() ? (
            <button
              type="button"
              className="weq-set-iconbtn"
              aria-label="发送图片"
              title="发送图片"
              disabled={disabled || busy}
              onClick={onSendImages}
            >
              <Send size={18} />
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}
