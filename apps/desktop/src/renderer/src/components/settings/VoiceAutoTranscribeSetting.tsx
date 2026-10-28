import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Toggle } from './controls';

export function VoiceAutoTranscribeSetting() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, { enabled: active });
  const mutation = trpc.bootstrap.setAutoTranscribeVoice.useMutation();
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  async function save(enabled: boolean) {
    setError(null);
    try {
      await mutation.mutateAsync({ enabled });
      await utils.bootstrap.getSettings.invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <div className="weq-settings-appearance-card" data-setting-id="auto-transcribe-voice">
      <div className="weq-settings-appearance-head">
        <strong>语音消息自动转文字</strong>
        <Toggle
          label="语音消息自动转文字"
          checked={settings.data?.voiceTranscribe?.autoTranscribe ?? false}
          disabled={!settings.data || mutation.isLoading}
          onChange={(enabled) => void save(enabled)}
        />
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
