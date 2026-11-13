import { Captions, Loader2 } from 'lucide-react';
import { MessageMenuButton } from './MessageMenuButton';
import type { Message } from '../im-template/template/types';
import type { MessageMediaTarget } from '../../../shared/message_media';
import {
  useVoiceTranscription,
  type VoiceTranscriptionInput,
} from '../hooks/useVoiceTranscription';

function VoiceAction({ input, onClose }: { input: VoiceTranscriptionInput; onClose?: () => void }) {
  const voice = useVoiceTranscription(input);
  if (voice.result?.success) return null;
  return (
    <MessageMenuButton
      type="button"
      title={
        voice.busy
          ? '正在转写语音'
          : voice.available
            ? '转换为文字'
            : '请先在设置中下载本地语音模型'
      }
      disabled={!voice.available || voice.busy}
      onClick={() => {
        voice.run();
        onClose?.();
      }}
    >
      {voice.busy ? <Loader2 size={17} className="weq-spin" /> : <Captions size={17} />}
      <span>{voice.busy ? '转写中' : '转换为文字'}</span>
    </MessageMenuButton>
  );
}

export function VoiceTranscribeMenuAction({
  message,
  onClose,
  target,
}: {
  message: Message;
  onClose?: () => void;
  target?: Pick<MessageMediaTarget, 'name' | 'token'>;
}) {
  const data = message.qqElements?.find(
    (element) =>
      element.type === 'ptt' &&
      (!target ||
        (String(element.data?.fileName ?? '') === target.name &&
          String(element.data?.fileToken ?? '') === target.token)),
  )?.data;
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
