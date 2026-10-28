import { FileText, Loader2 } from 'lucide-react';
import type { Message } from '../im-template/template/types';
import {
  useVoiceTranscription,
  type VoiceTranscriptionInput,
} from '../hooks/useVoiceTranscription';

function VoiceAction({ input, onClose }: { input: VoiceTranscriptionInput; onClose?: () => void }) {
  const voice = useVoiceTranscription(input);
  if (voice.result?.success) return null;
  return (
    <button
      type="button"
      title={voice.available ? '转换为文字' : '请先在设置中选择本地语音模型'}
      disabled={!voice.available || voice.busy}
      onClick={() => {
        voice.run();
        onClose?.();
      }}
    >
      {voice.busy ? <Loader2 size={17} className="weq-spin" /> : <FileText size={17} />}
      <span>{voice.busy ? '转写中' : '转换为文字'}</span>
    </button>
  );
}

export function VoiceTranscribeMenuAction({
  message,
  onClose,
}: {
  message: Message;
  onClose?: () => void;
}) {
  const data = message.qqElements?.find((element) => element.type === 'ptt')?.data;
  if (
    !data ||
    data.pttTranscript ||
    data.localPath ||
    data.localPreviewUrl ||
    typeof data.fileName !== 'string' ||
    !data.fileName
  )
    return null;
  return (
    <VoiceAction
      input={{
        t: message.createdAt ? Date.parse(message.createdAt) : 0,
        name: data.fileName,
        token: typeof data.fileToken === 'string' ? data.fileToken : '',
        msgId: message.msgId ?? '',
      }}
      onClose={onClose}
    />
  );
}
