import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs.shared';
import { Row, Toggle } from './controls';

export function OcrPrefilterSetting() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const mutation = trpc.bootstrap.setOcrPrefilterEnabled.useMutation();
  const autoOriginal = trpc.bootstrap.setOcrAutoDownloadOriginal.useMutation();
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  async function save(write: () => Promise<unknown>) {
    setError(null);
    try {
      await write();
      await utils.bootstrap.getSettings.invalidate();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <>
      <Row
        settingId="ocr-prefilter-enabled"
        desc="自动识别前跳过无文字图片。手动文字识别不受影响；筛图不可用时继续识别。"
        control={
          <Toggle
            label="OCR 前先筛图"
            checked={settings.data?.ocr.prefilterEnabled ?? true}
            disabled={!settings.data || mutation.isLoading}
            onChange={(enabled) => void save(() => mutation.mutateAsync({ enabled }))}
          />
        }
      />
      <Row
        settingId="ocr-auto-download-original"
        desc="识别时补取未缓存的聊天原图；关闭时仍可用已有图片或 QQ 在线识别。"
        control={
          <Toggle
            label="OCR 时自动获取原图"
            checked={settings.data?.ocr.autoDownloadOriginal ?? false}
            disabled={!settings.data || autoOriginal.isLoading}
            onChange={(enabled) => void save(() => autoOriginal.mutateAsync({ enabled }))}
          />
        }
      />
      {settings.error ? <p role="alert">{settings.error.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
