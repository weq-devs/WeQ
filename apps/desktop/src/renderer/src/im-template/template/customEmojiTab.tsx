import { useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/bmp';

export function CustomEmojiTab({
  disabled,
  disabledHint,
  onInsert,
}: {
  disabled: boolean;
  disabledHint?: string;
  onInsert?: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  return (
    <div className="custom-emoji-tab">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (!file || disabled) return;
          if (!file.size || file.size > MAX_BYTES) {
            setError(file.size ? '图片超过 10 MB，请换一张。' : '图片文件为空，请换一张。');
          } else {
            setError('');
            onInsert?.(file);
          }
        }}
      />
      <button
        type="button"
        className="custom-emoji-upload"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title={disabled ? disabledHint : undefined}
      >
        <ImagePlus size={24} />
        <span>选择图片或 GIF</span>
        <span className="custom-emoji-hint">将图片以表情形式放入输入框</span>
      </button>
      {error ? (
        <p role="alert" className="custom-emoji-hint">
          {error}
        </p>
      ) : null}
    </div>
  );
}
