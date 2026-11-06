import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Row, Toggle } from './controls';

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
  const toggle = (
    <Toggle
      label="语音消息自动转文字"
      checked={settings.data?.voiceTranscribe?.autoTranscribe ?? false}
      disabled={!settings.data || mutation.isLoading}
      onChange={(enabled) => void save(enabled)}
    />
  );
  return (
    <>
      <Row settingId="auto-transcribe-voice" label="语音消息自动转文字" control={toggle} />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
