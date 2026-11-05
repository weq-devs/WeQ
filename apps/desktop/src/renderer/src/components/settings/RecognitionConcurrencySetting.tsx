import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Row } from './controls';
import '../../styles/recognition-settings.css';

export function RecognitionConcurrencySetting({ kind }: { kind: 'ocr' | 'voice' }) {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, { enabled: active });
  const mutation = trpc.bootstrap.setRecognitionConcurrency.useMutation();
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);
  const label = kind === 'ocr' ? '识别并发' : '转录并发';
  const value =
    (kind === 'ocr' ? settings.data?.ocr : settings.data?.voiceTranscribe)?.onlineConcurrency ?? 5;

  async function save(concurrency: number) {
    setError(null);
    try {
      await mutation.mutateAsync({ kind, concurrency });
      await utils.bootstrap.getSettings.invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <Row
        settingId={`${kind}-online-concurrency`}
        label={label}
        desc={`导出时同时向 QQ 发起的${kind === 'ocr' ? '图片识别' : '语音转写'}请求数`}
        control={
          <input
            key={value}
            className="weq-set-input weq-number weq-recognition-concurrency"
            type="number"
            aria-label={label}
            min={1}
            max={32}
            step={1}
            defaultValue={value}
            disabled={!settings.data || mutation.isLoading}
            onBlur={(event) => {
              const next = event.target.valueAsNumber;
              if (Number.isInteger(next) && next >= 1 && next <= 32) {
                if (next !== value) void save(next);
              } else event.currentTarget.value = String(value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
