import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Row, Toggle } from './controls';

export function OcrPrefilterSetting() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutation = trpc.bootstrap.setOcrPrefilterEnabled.useMutation();
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
    <>
      <Row
        settingId="ocr-prefilter-enabled"
        label="OCR 前先筛图"
        desc="全局用于非手动 OCR，跳过无文字图片。手动文字识别不受影响；筛图不可用时继续识别。"
        control={
          <Toggle
            label="OCR 前先筛图"
            checked={settings.data?.ocr.prefilterEnabled ?? true}
            disabled={!settings.data || mutation.isLoading}
            onChange={(enabled) => void save(enabled)}
          />
        }
      />
      {settings.error ? <p role="alert">{settings.error.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
